import { listCandidateOrders, markOrderShipped, resolveCarrierCode } from './shipstation.js';
import {
  buildPrintfulOrder,
  createOrder,
  findByExternalId,
  getPrintfulOrder
} from './printful.js';
import { loadState, saveState } from './state.js';

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
    group.orders.push(order);
    group.shipstationOrderIds.push(Number(order.orderId));
  }

  return [...groups.values()];
}

export function getLastRun() {
  return lastRun;
}

export function getLastTrackingRun() {
  return lastTrackingRun;
}

export async function runImport(config) {
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
    const [orders, state] = await Promise.all([
      listCandidateOrders(config),
      loadState(config.stateFile)
    ]);

    const groups = groupOrders(orders);
    output.shipstationRecordsFound = orders.length;
    output.groupedOrdersFound = groups.length;

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
        const printfulOrder = existingPrintful || await createOrder(payload, config);

        state.orders[stateKey] = {
          status: 'submitted',
          orderNumber: group.orderNumber,
          shipstationOrderIds: group.shipstationOrderIds,
          printfulOrderId: printfulOrder.id,
          printfulExternalId: payload.external_id,
          submittedAt: new Date().toISOString(),
          shipments: {}
        };

        await saveState(config.stateFile, state);

        output.submitted += 1;
        output.orders.push({
          orderNumber: group.orderNumber,
          status: existingPrintful ? 'existing_printful_order' : 'submitted',
          printfulOrderId: printfulOrder.id,
          shipstationOrderIds: group.shipstationOrderIds
        });

        await sleep(config.printfulRequestDelayMs);
      } catch (error) {
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

function extractShipments(order) {
  const shipments = Array.isArray(order?.shipments) ? order.shipments : [];

  return shipments
    .map((shipment, index) => ({
      key: String(
        shipment.id ||
        shipment.tracking_number ||
        shipment.trackingNumber ||
        index
      ),
      carrier: shipment.carrier || shipment.carrier_name || shipment.service || '',
      trackingNumber:
        shipment.tracking_number ||
        shipment.trackingNumber ||
        shipment.tracking_code ||
        '',
      shipDate:
        shipment.ship_date ||
        shipment.shipped_at ||
        shipment.created ||
        new Date().toISOString()
    }))
    .filter(shipment => shipment.trackingNumber);
}

function dateOnly(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
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
        const printfulOrder = await getPrintfulOrder(record.printfulOrderId, config);
        const shipments = extractShipments(printfulOrder);

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
            shipstationOrderIds: record.shipstationOrderIds,
            trackingNumber: shipment.trackingNumber,
            carrierCode
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
