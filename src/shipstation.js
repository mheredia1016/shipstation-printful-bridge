const BASE_URL = 'https://ssapi.shipstation.com';

function authHeader(apiKey, apiSecret) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A single queue for all ShipStation calls (including shipment updates).
// The shared cooldown is updated from every response, so a 429 pauses all callers.
let shipstationRequestQueue = Promise.resolve();
let lastShipstationRequestAt = 0;
let shipstationCooldownUntil = 0;

function rateLimitResetMs(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) {
    // Some services report seconds until reset; others use epoch seconds/ms.
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return Date.now() + Math.max(0, n) * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) return Math.max(1000, n * 1000);
    const parsed = Date.parse(retryAfter);
    if (!Number.isNaN(parsed)) return Math.max(1000, parsed - Date.now());
  }
  const resetAt = rateLimitResetMs(response.headers.get('x-rate-limit-reset'));
  if (resetAt > Date.now()) return Math.max(1000, resetAt - Date.now() + 250);
  return Math.min(120000, 5000 * (2 ** attempt));
}

async function withShipstationThrottle(config, fn) {
  const task = shipstationRequestQueue.catch(() => {}).then(async () => {
    const delayMs = Math.max(0, Number(config.shipstationGlobalDelayMs || 1500));
    const earliest = Math.max(lastShipstationRequestAt + delayMs, shipstationCooldownUntil);
    if (earliest > Date.now()) await sleep(earliest - Date.now());
    try {
      const response = await fn();
      const remaining = Number(response.headers.get('x-rate-limit-remaining'));
      const resetAt = rateLimitResetMs(response.headers.get('x-rate-limit-reset'));
      if (response.status === 429) {
        shipstationCooldownUntil = Math.max(shipstationCooldownUntil, Date.now() + retryDelayMs(response, 0));
      } else if (response.headers.has('x-rate-limit-remaining') && Number.isFinite(remaining) && remaining <= 1 && resetAt > Date.now()) {
        shipstationCooldownUntil = Math.max(shipstationCooldownUntil, resetAt + 250);
      }
      return response;
    } finally {
      lastShipstationRequestAt = Date.now();
    }
  });
  shipstationRequestQueue = task;
  return task;
}

async function request(path, config, options = {}) {
  const maxRetries = Math.max(1, Number(config.apiMaxRetries || 6));
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await withShipstationThrottle(config, () =>
      fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authHeader(config.shipstationApiKey, config.shipstationApiSecret),
          ...(config.shipstationPartnerKey ? { 'x-partner': config.shipstationPartnerKey } : {}),
          ...(options.headers || {})
        }
      })
    );
    const responseText = await response.text();
    let body;
    try { body = responseText ? JSON.parse(responseText) : {}; }
    catch { body = { raw: responseText }; }
    if (response.status === 429 && attempt < maxRetries) {
      const delay = retryDelayMs(response, attempt);
      shipstationCooldownUntil = Math.max(shipstationCooldownUntil, Date.now() + delay);
      console.warn(`ShipStation 429 on ${path}. Shared cooldown ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries}).`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`ShipStation ${response.status}: ${JSON.stringify(body).slice(0, 1400)}`);
    }
    return body;
  }
  throw new Error(`ShipStation request failed after ${maxRetries} retries: ${path}`);
}

let storesCache = {
  expiresAt: 0,
  stores: []
};


export async function listStores(config, { force = false } = {}) {
  const now = Date.now();

  if (
    !force &&
    storesCache.stores.length &&
    storesCache.expiresAt > now
  ) {
    return storesCache.stores;
  }

  const result = await request('/stores', config);
  const stores = Array.isArray(result) ? result : [];

  storesCache = {
    stores,
    expiresAt: now + (15 * 60 * 1000)
  };

  return stores;
}

export async function verifyShipStation(config) {
  const [result, stores] = await Promise.all([
    request(`/orders?pageSize=1&page=1&storeId=${encodeURIComponent(config.shipstationStoreId)}`, config),
    listStores(config)
  ]);

  const selectedStore =
    stores.find(store => String(store.storeId) === String(config.shipstationStoreId)) || null;

  return {
    connected: true,
    selectedStoreId: config.shipstationStoreId,
    selectedStore,
    returnedOrders: Array.isArray(result.orders) ? result.orders.length : 0,
    totalOrders: Number(result.total || 0)
  };
}

export async function listCandidateOrders(config, options = {}) {
  const candidates = [];

  const shouldStop = typeof options.shouldStop === 'function'
    ? options.shouldStop
    : null;

  const startPage = Math.max(1, Number(options.startPage || 1));
  const pagesToScan = options.pagesToScan == null
    ? null
    : Math.max(1, Number(options.pagesToScan));
  const endPage = pagesToScan == null
    ? Number(config.maxPages)
    : Math.min(Number(config.maxPages), startPage + pagesToScan - 1);
  const scanLabel = options.scanLabel ? `[${options.scanLabel}] ` : '';
  const onPage = typeof options.onPage === 'function' ? options.onPage : null;

  for (let page = startPage; page <= endPage; page += 1) {
    const params = new URLSearchParams({
      orderStatus: config.shipstationOrderStatus,
      storeId: String(config.shipstationStoreId),
      pageSize: String(config.pageSize),
      page: String(page),
      sortBy: 'OrderDate',
      sortDir: options.sortDir || (config.shipstationScanNewestFirst ? 'DESC' : 'ASC')
    });

    // ShipStation v1 supports order-date bounds on List Orders. Reconciliation
    // uses these so the audit is independent of how large the total Awaiting
    // Shipment backlog becomes.
    if (options.orderDateStart) params.set('orderDateStart', options.orderDateStart);
    if (options.orderDateEnd) params.set('orderDateEnd', options.orderDateEnd);

    const result = await request(`/orders?${params}`, config);
    const orders = Array.isArray(result.orders) ? result.orders : [];

    const pageCandidates = [];
    for (const order of orders) {
      const values = String(order?.advancedOptions?.customField1 || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);

      // Any comma-delimited routing token beginning with "Printful" is eligible.
      // Examples: Printful, PrintfulEU, PrintfulCanada, PWT,PrintfulCanada.
      if (values.some(value => value.startsWith('printful'))) {
        candidates.push(order);
        pageCandidates.push(order);
      }
    }

    console.log(
      `[SHIPSTATION SCAN] ${scanLabel}page ${page}: ${orders.length} awaiting-shipment record(s), ` +
      `${pageCandidates.length} eligible Printful record(s), ${candidates.length} eligible total.`
    );

    if (onPage) {
      await onPage({ page, pageCandidates, result, candidates });
    }

    if (shouldStop && await shouldStop(candidates, {
      page,
      pageCandidates,
      result
    })) {
      console.log(
        `[SHIPSTATION SCAN] ${scanLabel}Early stop after page ${page}; catch-up batch is full.`
      );
      break;
    }

    if (orders.length < config.pageSize || page >= Number(result.pages || 1)) break;
    await sleep(config.shipstationPageDelayMs || 1500);
  }

  return candidates;
}

export async function listCarriers(config) {
  const carriers = await request('/carriers', config);
  return Array.isArray(carriers) ? carriers : [];
}

function normalizeCarrier(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export async function resolveCarrierCode(carrierName, config) {
  const raw = String(carrierName || '').trim();
  if (!raw) return config.shipstationFallbackCarrierCode;

  const known = {
    usps: 'usps',
    ups: 'ups',
    fedex: 'fedex',
    dhl: 'dhl_express',
    dhlexpress: 'dhl_express',
    royalmail: 'royal_mail',
    dpd: 'dpd',
    dpduk: 'dpd',
    evri: 'hermes',
    hermes: 'hermes',
    asendia: 'asendia',
    canadapost: 'canada_post'
  };

  const normalized = normalizeCarrier(raw);
  if (known[normalized]) return known[normalized];

  try {
    const carriers = await listCarriers(config);
    const match = carriers.find(carrier => {
      return (
        normalizeCarrier(carrier.code) === normalized ||
        normalizeCarrier(carrier.name) === normalized
      );
    });
    if (match?.code) return match.code;
  } catch (error) {
    console.warn(`Could not load ShipStation carriers: ${error.message}`);
  }

  return config.shipstationFallbackCarrierCode;
}

export async function markOrderShipped({
  orderId,
  carrierCode,
  shipDate,
  trackingNumber
}, config) {
  return request('/orders/markasshipped', config, {
    method: 'POST',
    body: JSON.stringify({
      orderId: Number(orderId),
      carrierCode,
      shipDate,
      trackingNumber,
      notifyCustomer: config.shipstationNotifyCustomer,
      notifySalesChannel: config.shipstationNotifySalesChannel
    })
  });
}


export async function findOrdersByExactOrderNumber(orderNumber, config) {
  const wanted = String(orderNumber || '').trim();
  if (!wanted) throw new Error('ShipStation order number is required.');

  const params = new URLSearchParams({
    orderNumber: wanted,
    storeId: String(config.shipstationStoreId),
    pageSize: '500',
    page: '1'
  });

  const result = await request(`/orders?${params}`, config);
  const orders = Array.isArray(result.orders) ? result.orders : [];

  // ShipStation orderNumber filtering is "starts with"; force exact match.
  return orders.filter(order =>
    String(order.orderNumber || '').trim() === wanted
  );
}
