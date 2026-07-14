const BASE_URL = 'https://ssapi.shipstation.com';

function authHeader(apiKey, apiSecret) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

async function request(path, config, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader(config.shipstationApiKey, config.shipstationApiSecret),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`ShipStation ${response.status}: ${JSON.stringify(body).slice(0, 1400)}`);
  }

  return body;
}

export async function listStores(config) {
  const result = await request('/stores', config);
  return Array.isArray(result) ? result : [];
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

export async function listCandidateOrders(config) {
  const candidates = [];
  const expected = config.customFieldValue.trim().toLowerCase();

  for (let page = 1; page <= config.maxPages; page += 1) {
    const params = new URLSearchParams({
      orderStatus: config.shipstationOrderStatus,
      storeId: String(config.shipstationStoreId),
      pageSize: String(config.pageSize),
      page: String(page),
      sortBy: 'OrderDate',
      sortDir: 'ASC'
    });

    const result = await request(`/orders?${params}`, config);
    const orders = Array.isArray(result.orders) ? result.orders : [];

    for (const order of orders) {
      const value = String(order?.advancedOptions?.customField1 || '').trim().toLowerCase();
      if (value === expected) candidates.push(order);
    }

    if (orders.length < config.pageSize || page >= Number(result.pages || 1)) break;
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
