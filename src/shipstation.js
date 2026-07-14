const BASE_URL = 'https://ssapi.shipstation.com';

function authHeader(apiKey, apiSecret) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

async function request(path, config, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
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
    throw new Error(`ShipStation ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`);
  }

  return body;
}

export async function verifyShipStation(config) {
  const result = await request('/orders?pageSize=1&page=1', config);
  return {
    connected: true,
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
      pageSize: String(config.pageSize),
      page: String(page),
      sortBy: 'OrderDate',
      sortDir: 'ASC'
    });

    const result = await request(`/orders?${params}`, config);
    const orders = Array.isArray(result.orders) ? result.orders : [];

    for (const order of orders) {
      const customField1 = String(order?.advancedOptions?.customField1 || '').trim().toLowerCase();
      if (customField1 === expected) candidates.push(order);
    }

    if (orders.length < config.pageSize || page >= Number(result.pages || 1)) break;
  }

  return candidates;
}
