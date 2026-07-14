import { listCandidateOrders } from './shipstation.js';
import { buildPrintfulOrder, createOrder, findByExternalId } from './printful.js';
import { loadState, saveState } from './state.js';

let running = false;
let lastRun = null;

function summarizeOrder(order, stateRecord) {
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
      quantity: item.quantity
    })),
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

  const output = {
    startedAt: new Date().toISOString(),
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
    const [orders, state] = await Promise.all([
      listCandidateOrders(config),
      loadState(config.stateFile)
    ]);

    const selected = forceOrderId
      ? orders.filter(order => String(order.orderId) === String(forceOrderId))
      : orders;

    output.found = selected.length;

    for (const order of selected) {
      const stateKey = String(order.orderId);
      const existingState = state.orders[stateKey];
      const summary = summarizeOrder(order, existingState);
      output.orders.push(summary);

      if (existingState?.status === 'submitted') {
        output.skipped += 1;
        continue;
      }

      try {
        const payload = buildPrintfulOrder(order, config);
        summary.payloadPreview = payload;

        if (config.printfulMode === 'preview') {
          summary.bridgeStatus = 'preview';
          output.previewed += 1;
          continue;
        }

        const existingPrintful = await findByExternalId(payload.external_id, config);
        const printfulOrder = existingPrintful || await createOrder(payload, config);

        state.orders[stateKey] = {
          status: 'submitted',
          mode: config.printfulMode,
          orderNumber: order.orderNumber,
          printfulOrderId: printfulOrder.id,
          printfulExternalId: payload.external_id,
          submittedAt: new Date().toISOString()
        };

        summary.bridgeStatus = existingPrintful ? 'existing_printful_order' : 'submitted';
        summary.printfulOrderId = printfulOrder.id;
        summary.printfulExternalId = payload.external_id;
        output.submitted += 1;

        await saveState(config.stateFile, state);
      } catch (error) {
        state.orders[stateKey] = {
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
