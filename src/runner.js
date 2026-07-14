import { listCandidateOrders } from './shipstation.js';
import { buildPrintfulOrder, createOrder, findByExternalId } from './printful.js';
import { loadMappings, mapOrderItems } from './mappings.js';
import { loadState, saveState } from './state.js';

let running = false;
let lastRun = null;

function summarizeOrder(order, mappingResult, stateRecord) {
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    status: order.orderStatus,
    customField1: order?.advancedOptions?.customField1 || '',
    recipient: order?.shipTo?.name || '',
    country: order?.shipTo?.country || '',
    items: (order.items || []).map(item => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      mapped: mappingResult.mapped.some(entry => entry.item === item)
    })),
    missingMappings: mappingResult.missing,
    bridgeStatus: stateRecord?.status || 'new',
    printfulOrderId: stateRecord?.printfulOrderId || null,
    error: stateRecord?.error || null
  };
}

export function getLastRun() {
  return lastRun;
}

export async function runImport(config, { forceOrderId = null } = {}) {
  if (running) throw new Error('An import is already running.');
  running = true;

  const startedAt = new Date().toISOString();
  const output = {
    startedAt,
    finishedAt: null,
    mode: config.printfulMode,
    found: 0,
    previewed: 0,
    submitted: 0,
    skipped: 0,
    failed: 0,
    orders: []
  };

  try {
    const [orders, mappings, state] = await Promise.all([
      listCandidateOrders(config),
      loadMappings(config.mappingFile),
      loadState(config.stateFile)
    ]);

    const selected = forceOrderId
      ? orders.filter(order => String(order.orderId) === String(forceOrderId))
      : orders;

    output.found = selected.length;

    for (const order of selected) {
      const existingState = state.orders[String(order.orderId)];
      const mappingResult = mapOrderItems(order, mappings);
      const summary = summarizeOrder(order, mappingResult, existingState);
      output.orders.push(summary);

      if (existingState?.status === 'submitted') {
        output.skipped += 1;
        continue;
      }

      if (mappingResult.missing.length > 0 || mappingResult.mapped.length === 0) {
        summary.bridgeStatus = 'mapping_required';
        output.skipped += 1;
        continue;
      }

      const payload = buildPrintfulOrder(order, mappingResult.mapped);
      summary.payloadPreview = payload;

      if (config.printfulMode === 'preview') {
        summary.bridgeStatus = 'preview';
        output.previewed += 1;
        continue;
      }

      try {
        const existingPrintful = await findByExternalId(payload.external_id, config);
        const printfulOrder = existingPrintful || await createOrder(payload, config);

        state.orders[String(order.orderId)] = {
          status: 'submitted',
          mode: config.printfulMode,
          orderNumber: order.orderNumber,
          printfulOrderId: printfulOrder.id,
          printfulExternalId: payload.external_id,
          submittedAt: new Date().toISOString()
        };

        summary.bridgeStatus = 'submitted';
        summary.printfulOrderId = printfulOrder.id;
        output.submitted += 1;
        await saveState(config.stateFile, state);
      } catch (error) {
        state.orders[String(order.orderId)] = {
          status: 'error',
          orderNumber: order.orderNumber,
          error: error.message,
          updatedAt: new Date().toISOString()
        };
        summary.bridgeStatus = 'error';
        summary.error = error.message;
        output.failed += 1;
        await saveState(config.stateFile, state);
      }
    }

    output.finishedAt = new Date().toISOString();
    lastRun = output;
    return output;
  } finally {
    running = false;
  }
}
