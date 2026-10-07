import {
  listCandidateOrders,
  markOrderShipped,
  resolveCarrierCode,
  findOrdersByExactOrderNumber
} from './shipstation.js';
import {
  buildPrintfulOrder,
  createOrder,
  confirmOrder,
  findByExternalId,
  getPrintfulOrder,
  getPrintfulShipments,
  updateDraftOrder
} from './printful.js';
import {
  loadState,
  saveState,
  loadReconcile30DayCursor,
  saveReconcile30DayCursor,
  loadReconcile30DayResolved,
  markReconcile30DayResolved
} from './state.js';

let importRunning = false;
let trackingRunning = false;
let lastRun = null;
let lastTrackingRun = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function groupOrders(orders) {
  const groups = new Map();

  for (const order of orders) {
    const key = String(order.orderNumber || order.orderId);
    if (!groups.has(key)) {
      groups.set(key, {
        orderNumber: key,
        orders: [],
        shipstationOrderIds: []
      });
    }

    const group = groups.get(key);

    // v3.26: the same ShipStation record can be returned by more than one
    // discovery pass (NEWEST, BACKLOG, and 30-DAY). Never append the same
    // ShipStation orderId twice or its line items will be duplicated in the
    // Printful payload and Printful will reject the order with
    // "Duplicate item external ID".
    const shipstationOrderId = Number(order.orderId);
    const alreadyIncluded = group.shipstationOrderIds.some(
      existingId => Number(existingId) === shipstationOrderId
    );

    if (!alreadyIncluded) {
      group.orders.push(order);
      group.shipstationOrderIds.push(shipstationOrderId);
    }
  }

  return [...groups.values()];
}

export function getLastRun() {
  return lastRun;
}

export function getLastTrackingRun() {
  return lastTrackingRun;
}

export async function runImport(config, options = {}) {
  if (importRunning) throw new Error('An import is already running.');
  importRunning = true;

  const output = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    mode: config.printfulMode,
    shipstationRecordsFound: 0,
    groupedOrdersFound: 0,
    submitted: 0,
    skipped: 0,
    failed: 0,
    orders: []
  };

  try {
    const state = await loadState(config.stateFile);

    let orders;
    const requestedOrderNumber = String(options.orderNumber || '').trim();

    // v3.30 discovery-source tracking for historical-first batching.
    const priority30DayNumbers = new Set();
    const priorityNewestNumbers = new Set();
    const priorityBacklogNumbers = new Set();

    if (requestedOrderNumber) {
      const exactOrders = await findOrdersByExactOrderNumber(
        requestedOrderNumber,
        config
      );

      orders = exactOrders.filter(order => {
        const correctStatus =
          String(order.orderStatus || '').toLowerCase() ===
          String(config.shipstationOrderStatus || '').toLowerCase();

        const fieldValues = String(
          order?.advancedOptions?.customField1 || ''
        )
          .split(',')
          .map(value => value.trim().toLowerCase())
          .filter(Boolean);

        return (
          correctStatus &&
          fieldValues.some(value => value.startsWith('printful'))
        );
      });

      if (!orders.length) {
        throw new Error(
          `${requestedOrderNumber} was not eligible. It must be in ` +
          `${config.shipstationOrderStatus} and Custom Field 1 must contain ` +
          `a comma-delimited token beginning with Printful.`
        );
      }
    } else if (config.catchupEnabled) {
      const batchSize = Math.max(1, Number(config.catchupBatchSize || 25));

      // Pass 1: always protect new orders by taking the newest unresolved batch.
      const newestOrders = await listCandidateOrders(config, {
        scanLabel: 'NEWEST',
        shouldStop: async candidates => {
          const candidateGroups = groupOrders(candidates);
          const unresolved = candidateGroups.filter(group => {
            const existing = state.orders?.[group.orderNumber];
            return !existing ||
              !['submitted', 'shipped'].includes(String(existing.status || ''));
          });
          return unresolved.length >= batchSize;
        }
      });

      const newestGroups = groupOrders(newestOrders).filter(group => {
        const existing = state.orders?.[group.orderNumber];
        return !existing ||
          !['submitted', 'shipped'].includes(String(existing.status || ''));
      }).slice(0, batchSize);
      const newestSelectedNumbers = new Set(
        newestGroups.map(group => group.orderNumber)
      );
      newestSelectedNumbers.forEach(number => priorityNewestNumbers.add(number));
      orders = newestOrders.filter(order =>
        newestSelectedNumbers.has(String(order.orderNumber || order.orderId))
      );

      // Pass 2: walk older ShipStation pages with a persistent cursor so an
      // old backlog can never remain hidden behind the newest page forever.
      if (config.backlogEnabled) {
        const backlogBatchSize = Math.max(1, Number(config.backlogBatchSize || 25));
        const firstBacklogPage = Math.max(2, Number(config.backlogStartPage || 2));
        let backlogPage = Math.max(
          firstBacklogPage,
          Number(state.meta?.shipstationBacklogPage || firstBacklogPage)
        );
        let lastScannedPage = backlogPage;
        let totalPages = Number(config.maxPages || 1);

        if (backlogPage > Number(config.maxPages || 1)) backlogPage = firstBacklogPage;

        const backlogOrders = await listCandidateOrders(config, {
          startPage: backlogPage,
          pagesToScan: Math.max(1, Number(config.backlogPagesPerRun || 2)),
          scanLabel: 'BACKLOG',
          onPage: ({ page, result }) => {
            lastScannedPage = page;
            totalPages = Math.min(
              Number(config.maxPages || 1),
              Math.max(1, Number(result?.pages || 1))
            );
          }
        });

        const backlogGroups = groupOrders(backlogOrders);
        const unresolvedBacklog = backlogGroups.filter(group => {
          const existing = state.orders?.[group.orderNumber];
          return !existing ||
            !['submitted', 'shipped'].includes(String(existing.status || ''));
        });
        const selectedBacklog = unresolvedBacklog.slice(0, backlogBatchSize);
        const selectedNumbers = new Set(selectedBacklog.map(group => group.orderNumber));
        selectedNumbers.forEach(number => priorityBacklogNumbers.add(number));

        // Only add records belonging to the selected backlog groups.
        orders.push(...backlogOrders.filter(order =>
          selectedNumbers.has(String(order.orderNumber || order.orderId))
        ));

        // If everything unresolved in the scanned window fits in this run,
        // advance. Otherwise keep the cursor here until this window is drained.
        if (unresolvedBacklog.length <= backlogBatchSize) {
          const nextPage = lastScannedPage + 1;
          state.meta.shipstationBacklogPage =
            nextPage > totalPages ? firstBacklogPage : nextPage;
        } else {
          state.meta.shipstationBacklogPage = backlogPage;
        }
        state.meta.shipstationBacklogUpdatedAt = new Date().toISOString();
        await saveState(config.stateFile, state);

        output.backlogPage = backlogPage;
        output.backlogLastScannedPage = lastScannedPage;
        output.backlogUnresolvedVisible = unresolvedBacklog.length;
        output.backlogBatchSelected = selectedBacklog.length;

        console.log(
          `[BACKLOG] pages ${backlogPage}-${lastScannedPage}: ` +
          `${unresolvedBacklog.length} unresolved eligible order(s); ` +
          `selected ${selectedBacklog.length}. Next cursor: ` +
          `${state.meta.shipstationBacklogPage}.`
        );
      }

      // Pass 3: independent 30-day reconciliation. This deliberately uses an
      // order-date window instead of the general Awaiting Shipment page cursor.
      // It walks the entire 30-day result set over successive runs and feeds
      // genuinely unresolved orders into the normal safe import path.
      if (config.reconcile30DayEnabled) {
        const reconcileBatchSize = Math.max(1, Number(config.reconcile30DayBatchSize || 25));
        const days = Math.max(1, Number(config.reconcile30DayDays || 30));
        const end = new Date();
        const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
        const orderDateStart = start.toISOString();
        const orderDateEnd = end.toISOString();
        let reconcilePage = await loadReconcile30DayCursor(
          config.stateFile,
          state.meta?.reconcile30DayPage || 1
        );
        console.log(`[30-DAY CURSOR] Loaded persistent cursor page ${reconcilePage}.`);
        let lastScannedPage = reconcilePage;
        let totalPages = reconcilePage;

        const reconcileOrders = await listCandidateOrders(config, {
          startPage: reconcilePage,
          pagesToScan: Math.max(1, Number(config.reconcile30DayPagesPerRun || 2)),
          scanLabel: '30-DAY OLDEST-FIRST',
          sortDir: 'ASC',
          orderDateStart,
          orderDateEnd,
          onPage: ({ page, result }) => {
            lastScannedPage = page;
            totalPages = Math.max(1, Number(result?.pages || 1));
          }
        });

        const reconcileGroups = groupOrders(reconcileOrders);
        const resolved30Day = await loadReconcile30DayResolved(config.stateFile);
        const unresolved30Day = reconcileGroups.filter(group => {
          const existing = state.orders?.[group.orderNumber];
          const stateResolved = existing && ['submitted', 'shipped'].includes(String(existing.status || ''));
          const ledgerResolved = Boolean(resolved30Day?.[group.orderNumber]);
          return !stateResolved && !ledgerResolved;
        });
        const ledgerResolvedVisible = reconcileGroups.length - unresolved30Day.length;
        if (ledgerResolvedVisible > 0) {
          console.log(
            `[30-DAY RESOLVED] Excluded ${ledgerResolvedVisible} already-accounted order(s) ` +
            `from pages ${reconcilePage}-${lastScannedPage}.`
          );
        }
        const selected30Day = unresolved30Day.slice(0, reconcileBatchSize);
        const selected30DayNumbers = new Set(selected30Day.map(group => group.orderNumber));
        selected30DayNumbers.forEach(number => priority30DayNumbers.add(number));

        // Avoid processing the same order twice if NEWEST/BACKLOG already
        // selected it during this same run.
        const alreadySelected = new Set(
          orders.map(order => String(order.orderNumber || order.orderId))
        );
        orders.push(...reconcileOrders.filter(order => {
          const number = String(order.orderNumber || order.orderId);
          return selected30DayNumbers.has(number) && !alreadySelected.has(number);
        }));

        // Stay on the current window while it contains more unresolved orders
        // than we can process. Otherwise advance. At the end, restart at page 1
        // so every 30-day order is continuously audited.
        if (unresolved30Day.length <= reconcileBatchSize) {
          const nextPage = lastScannedPage + 1;
          state.meta.reconcile30DayPage = nextPage > totalPages ? 1 : nextPage;
        } else {
          state.meta.reconcile30DayPage = reconcilePage;
        }
        state.meta.reconcile30DayUpdatedAt = new Date().toISOString();
        state.meta.reconcile30DayStart = orderDateStart;
        state.meta.reconcile30DayEnd = orderDateEnd;

        // Persist this cursor independently before the shared state save.
        // This prevents a concurrent tracking job with stale state from
        // rolling reconciliation back to page 1.
        await saveReconcile30DayCursor(
          config.stateFile,
          state.meta.reconcile30DayPage,
          { lastScannedPage, orderDateStart, orderDateEnd }
        );
        console.log(`[30-DAY CURSOR] Persisted next page ${state.meta.reconcile30DayPage}.`);
        await saveState(config.stateFile, state);

        output.reconcile30DayPage = reconcilePage;
        output.reconcile30DayLastScannedPage = lastScannedPage;
        output.reconcile30DayUnresolvedVisible = unresolved30Day.length;
        output.reconcile30DayBatchSelected = selected30Day.length;

        console.log(
          `[30-DAY RECONCILE OLDEST-FIRST] ${orderDateStart.slice(0, 10)} through ${orderDateEnd.slice(0, 10)} | ` +
          `pages ${reconcilePage}-${lastScannedPage}: ${unresolved30Day.length} unresolved eligible order(s); ` +
          `selected ${selected30Day.length}. Next cursor: ${state.meta.reconcile30DayPage}.`
        );
      }
    } else {
      orders = await listCandidateOrders(config);
    }

    let groups = groupOrders(orders);
    output.shipstationRecordsFound = orders.length;
    output.groupedOrdersFound = groups.length;

    if (!requestedOrderNumber && config.catchupEnabled) {
      const newestBatchSize = Math.max(1, Number(config.catchupBatchSize || 25));
      const backlogBatchSize = config.backlogEnabled
        ? Math.max(1, Number(config.backlogBatchSize || 25))
        : 0;
      const reconcileBatchSize = config.reconcile30DayEnabled
        ? Math.max(1, Number(config.reconcile30DayBatchSize || 25))
        : 0;
      const unresolved = groups.filter(group => {
        const existing = state.orders?.[group.orderNumber];
        return !existing ||
          !['submitted', 'shipped'].includes(String(existing.status || ''));
      });

      // v3.31: historical recovery gets first claim on its own batch. An order
      // discovered by both NEWEST and 30-DAY is counted/processed as 30-DAY,
      // so today's scan can no longer steal historical recovery capacity.
      const reconcile = unresolved
        .filter(group => priority30DayNumbers.has(group.orderNumber))
        .slice(0, reconcileBatchSize);
      const reconcileNumbers = new Set(reconcile.map(group => group.orderNumber));

      const newest = unresolved
        .filter(group => priorityNewestNumbers.has(group.orderNumber) && !reconcileNumbers.has(group.orderNumber))
        .slice(0, newestBatchSize);
      const newestNumbers = new Set(newest.map(group => group.orderNumber));

      const backlog = unresolved
        .filter(group => priorityBacklogNumbers.has(group.orderNumber) &&
          !reconcileNumbers.has(group.orderNumber) && !newestNumbers.has(group.orderNumber))
        .slice(0, backlogBatchSize);

      groups = [...reconcile, ...newest, ...backlog];

      output.catchupUnresolvedVisible = unresolved.length;
      output.catchupBatchSelected = groups.length;

      console.log(
        `[CATCH-UP] ${unresolved.length} unresolved eligible order(s) visible; ` +
        `processing ${groups.length} this run ` +
        `(${reconcile.length} 30-day reconcile FIRST + ${newest.length} newest + ${backlog.length} backlog).`
      );
    }

    for (const group of groups) {
      const stateKey = group.orderNumber;
      const existing = state.orders[stateKey];

      if (existing?.status === 'submitted' || existing?.status === 'shipped') {
        output.skipped += 1;
        output.orders.push({
          orderNumber: group.orderNumber,
          status: existing.status,
          printfulOrderId: existing.printfulOrderId
        });
        continue;
      }

      try {
        const payload = await buildPrintfulOrder(group, config);

        if (config.printfulMode === 'preview') {
          output.orders.push({
            orderNumber: group.orderNumber,
            status: 'preview',
            payload
          });
          continue;
        }

        const existingPrintful = await findByExternalId(payload.external_id, config);
        let duplicateWasCanceled = false;
        let replacementExternalId = null;
        let printfulOrder = null;

        if (existingPrintful) {
          const existingStatus = String(existingPrintful.status || '').toLowerCase();

          if (existingStatus === 'canceled' || existingStatus === 'cancelled') {
            duplicateWasCanceled = true;

            // Printful retains canceled external IDs, so create/reuse a deterministic
            // replacement ID. This prevents a canceled order from blocking fulfillment
            // while still making retries idempotent.
            replacementExternalId = `${payload.external_id}-R1`;
            const replacement = await findByExternalId(replacementExternalId, config);

            if (replacement) {
              console.log(
                `[CANCELED REPLACEMENT GUARD] ${group.orderNumber} replacement already exists ` +
                `(Printful ID ${replacement.id}, external ID ${replacementExternalId}); reusing it.`
              );
              printfulOrder = replacement;
            } else {
              console.log(
                `[CANCELED REPLACEMENT] ${group.orderNumber} has canceled Printful order ` +
                `${existingPrintful.id}; creating replacement ${replacementExternalId}.`
              );
              printfulOrder = await createOrder(
                { ...payload, external_id: replacementExternalId },
                config
              );
            }
          } else {
            console.log(
              `[DUPLICATE GUARD] ${group.orderNumber} already exists in Printful ` +
              `(Printful ID ${existingPrintful.id}); no new order will be created.`
            );
            printfulOrder = existingPrintful;
          }
        } else {
          printfulOrder = await createOrder(payload, config);
        }

        // Auto-confirm is intentionally strict. An item is production-ready
        // when it either uses a preconfigured sync_variant_id OR v3.19's
        // verified path: catalog variant + exact SKU-mapped Printful file ID.
        const items = Array.isArray(payload.items) ? payload.items : [];
        const allItemsSynced =
          items.length > 0 &&
          items.every(item =>
            Number(item.sync_variant_id) > 0 ||
            item._bridgeProductionReady === true
          );

        let autoConfirmed = false;
        let autoConfirmSkippedReason = null;

        if (config.printfulAutoConfirmSynced) {
          if (!allItemsSynced) {
            autoConfirmSkippedReason = 'one_or_more_items_not_synced';
            console.log(
              `[AUTO CONFIRM SKIP] ${group.orderNumber} | ` +
              `At least one item lacks a verified production configuration; leaving Draft.`
            );
          } else {
            const currentStatus = String(printfulOrder?.status || '').toLowerCase();

            if (['draft', 'failed'].includes(currentStatus)) {
              console.log(
                `[AUTO CONFIRM] ${group.orderNumber} | ` +
                `${items.length}/${items.length} item(s) are production-ready ` +
                `(synced variant or verified catalog variant + artwork); ` +
                `confirming Printful order ${printfulOrder.id}.`
              );
              printfulOrder = await confirmOrder(printfulOrder.id, config);
              autoConfirmed = true;
            } else {
              autoConfirmSkippedReason = `status_${currentStatus || 'unknown'}`;
              console.log(
                `[AUTO CONFIRM SKIP] ${group.orderNumber} | ` +
                `Printful order status is ${printfulOrder?.status || 'unknown'}; no confirm call needed.`
              );
            }
          }
        }

        state.orders[stateKey] = {
          status: 'submitted',
          orderNumber: group.orderNumber,
          shipstationOrderIds: group.shipstationOrderIds,
          printfulOrderId: printfulOrder.id,
          printfulExternalId: replacementExternalId || payload.external_id,
          replacedCanceledPrintfulOrderId: duplicateWasCanceled ? existingPrintful?.id : null,
          submittedAt: new Date().toISOString(),
          allItemsSynced,
          autoConfirmed,
          autoConfirmSkippedReason,
          printfulStatus: printfulOrder.status || null,
          shipments: {}
        };

        await saveState(config.stateFile, state);

        // v3.31: independently remember every successfully accounted order.
        // This includes newly-created Printful orders and DUPLICATE GUARD
        // matches, but never failed imports. The 30-day scanner therefore
        // drains forward even if a concurrent tracking job later writes an
        // older bridge-state.json snapshot.
        await markReconcile30DayResolved(config.stateFile, group.orderNumber, {
          printfulOrderId: printfulOrder.id,
          printfulExternalId: replacementExternalId || payload.external_id,
          source: existingPrintful ? 'duplicate_guard_or_existing' : 'created'
        });

        output.submitted += 1;
        output.orders.push({
          orderNumber: group.orderNumber,
          status: autoConfirmed
            ? 'auto_confirmed'
            : (duplicateWasCanceled
                ? 'replacement_for_canceled_order'
                : (existingPrintful ? 'existing_printful_order' : 'submitted')),
          printfulOrderId: printfulOrder.id,
          printfulStatus: printfulOrder.status || null,
          allItemsSynced,
          autoConfirmed,
          autoConfirmSkippedReason,
          shipstationOrderIds: group.shipstationOrderIds
        });

        await sleep(config.printfulRequestDelayMs);
      } catch (error) {
        console.error(
          `[IMPORT FAILED] ${group.orderNumber} | ${error?.message || error}`
        );

        state.orders[stateKey] = {
          status: 'error',
          orderNumber: group.orderNumber,
          shipstationOrderIds: group.shipstationOrderIds,
          error: error.message,
          updatedAt: new Date().toISOString()
        };
        await saveState(config.stateFile, state);

        output.failed += 1;
        output.orders.push({
          orderNumber: group.orderNumber,
          status: 'error',
          error: error.message
        });
      }
    }

    output.finishedAt = new Date().toISOString();
    lastRun = output;
    return output;
  } finally {
    importRunning = false;
  }
}


export async function reprocessOneOrder(orderNumber, config) {
  const wanted = String(orderNumber || '').trim();
  if (!wanted) throw new Error('orderNumber is required.');

  const orders = await findOrdersByExactOrderNumber(wanted, config);
  if (!orders.length) {
    throw new Error(`No exact ShipStation order found for ${wanted}.`);
  }

  const group = groupOrders(orders)[0];
  const payload = await buildPrintfulOrder(group, config);
  const existingPrintful = await findByExternalId(payload.external_id, config);

  if (!existingPrintful) {
    throw new Error(
      `Printful draft @${payload.external_id} was not found. ` +
      `This endpoint only updates an existing draft; it will not create a new order.`
    );
  }

  const status = String(existingPrintful.status || '').toLowerCase();
  if (!['draft', 'failed'].includes(status)) {
    throw new Error(
      `Printful order ${payload.external_id} is ${existingPrintful.status || 'unknown'}, not draft/failed. ` +
      `It was not changed.`
    );
  }

  const updated = await updateDraftOrder(`@${payload.external_id}`, payload, config);

  const state = await loadState(config.stateFile);
  state.orders ||= {};
  state.orders[group.orderNumber] = {
    ...(state.orders[group.orderNumber] || {}),
    status: 'submitted',
    orderNumber: group.orderNumber,
    shipstationOrderIds: group.shipstationOrderIds,
    printfulOrderId: updated.id || existingPrintful.id,
    printfulExternalId: payload.external_id,
    submittedAt: state.orders[group.orderNumber]?.submittedAt || new Date().toISOString(),
    reprocessedAt: new Date().toISOString(),
    shipments: state.orders[group.orderNumber]?.shipments || {}
  };
  await saveState(config.stateFile, state);

  return {
    ok: true,
    orderNumber: group.orderNumber,
    shipstationOrderIds: group.shipstationOrderIds,
    printfulOrderId: updated.id || existingPrintful.id,
    printfulExternalId: payload.external_id,
    statusBefore: existingPrintful.status,
    statusAfter: updated.status,
    itemCount: Array.isArray(updated.items) ? updated.items.length : payload.items.length,
    items: (updated.items || []).map(item => ({
      id: item.id,
      external_id: item.external_id,
      sync_variant_id: item.sync_variant_id,
      variant_id: item.variant_id,
      name: item.name,
      quantity: item.quantity
    }))
  };
}

function normalizeShipmentRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((shipment, index) => ({
      key: String(
        shipment.id ||
        shipment.tracking_number ||
        shipment.trackingNumber ||
        shipment.tracking_code ||
        index
      ),
      carrier:
        shipment.carrier ||
        shipment.carrier_name ||
        shipment.service ||
        shipment.shipping_method ||
        '',
      trackingNumber:
        shipment.tracking_number ||
        shipment.trackingNumber ||
        shipment.tracking_code ||
        '',
      shipDate:
        shipment.shipped_at ||
        shipment.ship_date ||
        shipment.shipDate ||
        shipment.created_at ||
        shipment.created ||
        new Date().toISOString(),
      shipmentStatus:
        shipment.shipment_status ||
        shipment.status ||
        '',
      trackingUrl:
        shipment.tracking_url ||
        shipment.trackingUrl ||
        '',
      items:
        shipment.shipment_items ||
        shipment.items ||
        []
    }))
    .filter(shipment => shipment.trackingNumber);
}

function extractLegacyShipments(order) {
  return normalizeShipmentRows(
    Array.isArray(order?.shipments) ? order.shipments : []
  );
}

function dateOnly(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}


export async function processPrintfulShipmentWebhook(event, config) {
  if (event?.type !== 'shipment_sent') {
    return {
      ignored: true,
      reason: `Unsupported event type: ${event?.type || '(missing)'}`
    };
  }

  const order = event?.data?.order || {};
  const shipment = event?.data?.shipment || {};
  const externalId = String(order.external_id || '').trim();
  const trackingNumber = String(shipment.tracking_number || '').trim();

  if (!externalId) {
    throw new Error('Printful shipment webhook is missing order.external_id.');
  }

  if (!trackingNumber) {
    throw new Error(
      `Printful shipment webhook for ${externalId} is missing tracking_number.`
    );
  }

  const state = await loadState(config.stateFile);

  let stateKey = externalId;
  let record = state.orders?.[stateKey];

  if (!record && order.id) {
    const match = Object.entries(state.orders || {}).find(([, candidate]) => {
      return String(candidate?.printfulOrderId || '') === String(order.id);
    });

    if (match) {
      [stateKey, record] = match;
    }
  }

  if (!record) {
    console.warn(
      `No bridge state mapping found for Printful order ${externalId}. ` +
      `Recovering directly from ShipStation...`
    );

    const recoveredOrders = await findOrdersByExactOrderNumber(
      externalId,
      config
    );

    if (!recoveredOrders.length) {
      throw new Error(
        `No bridge state mapping and no exact ShipStation order found for ` +
        `${externalId} (Printful ID ${order.id || 'unknown'}).`
      );
    }

    const matchingPrintfulOrders = recoveredOrders.filter(candidate => {
      const values = String(
        candidate?.advancedOptions?.customField1 || ''
      )
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);

      return values.some(value => value.startsWith('printful'));
    });

    const ordersToUse = matchingPrintfulOrders.length
      ? matchingPrintfulOrders
      : recoveredOrders;

    stateKey = externalId;
    record = {
      status: 'submitted',
      orderNumber: externalId,
      shipstationOrderIds: ordersToUse.map(candidate =>
        Number(candidate.orderId)
      ),
      printfulOrderId: order.id || null,
      printfulExternalId: externalId,
      recoveredFromShipStation: true,
      recoveredAt: new Date().toISOString(),
      shipments: {}
    };

    state.orders ||= {};
    state.orders[stateKey] = record;
    await saveState(config.stateFile, state);

    console.log(
      `Recovered ${externalId}: ShipStation order ID(s) ` +
      `${record.shipstationOrderIds.join(', ')}`
    );
  }

  record.shipments ||= {};

  const shipmentKey = String(
    shipment.id ||
    trackingNumber
  );

  if (record.shipments[shipmentKey]?.synced) {
    return {
      ok: true,
      duplicate: true,
      orderNumber: record.orderNumber || externalId,
      trackingNumber
    };
  }

  // Webhook v2 does not currently include a carrier field in its documented
  // shipment_sent payload, so use the configured fallback carrier code.
  const carrierCode = config.shipstationFallbackCarrierCode || 'other';
  const shipDate = dateOnly(
    shipment.shipped_at ||
    shipment.ship_date ||
    event.occurred_at ||
    new Date().toISOString()
  );

  let marked = 0;

  for (const orderId of record.shipstationOrderIds || []) {
    await markOrderShipped({
      orderId,
      carrierCode,
      shipDate,
      trackingNumber
    }, config);

    marked += 1;
  }

  record.shipments[shipmentKey] = {
    synced: true,
    source: 'printful-webhook',
    trackingNumber,
    trackingUrl: shipment.tracking_url || null,
    carrierCode,
    shipDate,
    syncedAt: new Date().toISOString()
  };

  record.status = 'shipped';
  record.updatedAt = new Date().toISOString();

  await saveState(config.stateFile, state);

  return {
    ok: true,
    duplicate: false,
    orderNumber: record.orderNumber || externalId,
    printfulOrderId: record.printfulOrderId || order.id || null,
    shipstationOrderIds: record.shipstationOrderIds || [],
    trackingNumber,
    trackingUrl: shipment.tracking_url || null,
    carrierCode,
    shipDate,
    shipstationOrdersMarked: marked
  };
}

export async function runTrackingSync(config) {
  if (trackingRunning) throw new Error('A tracking sync is already running.');
  trackingRunning = true;

  const output = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    checked: 0,
    shipmentsFound: 0,
    shipstationOrdersMarked: 0,
    skipped: 0,
    failed: 0,
    results: []
  };

  try {
    const state = await loadState(config.stateFile);

    for (const [stateKey, record] of Object.entries(state.orders || {})) {
      if (!record.printfulOrderId) continue;
      if (!['submitted', 'partially_shipped', 'shipped'].includes(record.status)) continue;

      output.checked += 1;

      try {
        let shipments = [];

        try {
          const v2Shipments = await getPrintfulShipments(
            record.printfulOrderId,
            config
          );
          shipments = normalizeShipmentRows(v2Shipments);
        } catch (shipmentError) {
          console.warn(
            `Printful v2 shipment lookup failed for ${record.orderNumber || stateKey}: ` +
            `${shipmentError.message}. Falling back to legacy order lookup.`
          );
        }

        // Fallback for older/legacy Printful responses.
        if (!shipments.length) {
          const printfulOrder = await getPrintfulOrder(
            record.printfulOrderId,
            config
          );
          shipments = extractLegacyShipments(printfulOrder);
        }

        if (!shipments.length) {
          output.skipped += 1;
          continue;
        }

        record.shipments ||= {};

        for (const shipment of shipments) {
          if (record.shipments[shipment.key]?.synced) continue;

          output.shipmentsFound += 1;
          const carrierCode = await resolveCarrierCode(shipment.carrier, config);

          for (const orderId of record.shipstationOrderIds || []) {
            await markOrderShipped({
              orderId,
              carrierCode,
              shipDate: dateOnly(shipment.shipDate),
              trackingNumber: shipment.trackingNumber
            }, config);

            output.shipstationOrdersMarked += 1;
          }

          record.shipments[shipment.key] = {
            synced: true,
            carrier: shipment.carrier,
            carrierCode,
            trackingNumber: shipment.trackingNumber,
            shipDate: dateOnly(shipment.shipDate),
            syncedAt: new Date().toISOString()
          };

          output.results.push({
            orderNumber: record.orderNumber,
            printfulOrderId: record.printfulOrderId,
            shipstationOrderIds: record.shipstationOrderIds,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl || null,
            carrier: shipment.carrier || null,
            carrierCode,
            shipmentStatus: shipment.shipmentStatus || null,
            shipDate: dateOnly(shipment.shipDate)
          });
        }

        const allKnownSynced = shipments.every(
          shipment => record.shipments[shipment.key]?.synced
        );

        record.status = allKnownSynced ? 'shipped' : 'partially_shipped';
        record.updatedAt = new Date().toISOString();
        await saveState(config.stateFile, state);
      } catch (error) {
        output.failed += 1;
        output.results.push({
          orderNumber: record.orderNumber || stateKey,
          error: error.message
        });
      }

      await sleep(config.printfulRequestDelayMs);
    }

    output.finishedAt = new Date().toISOString();
    lastTrackingRun = output;
    return output;
  } finally {
    trackingRunning = false;
  }
}
