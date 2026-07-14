const BASE_URL = 'https://api.printful.com';

async function request(path, config, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.printfulToken}`,
      ...(config.printfulStoreId ? {'X-PF-Store-Id': String(config.printfulStoreId)} : {}),
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

  if (!response.ok || (body.code && Number(body.code) >= 400)) {
    throw new Error(`Printful ${response.status}: ${JSON.stringify(body).slice(0, 1500)}`);
  }

  return body;
}

export async function verifyPrintful(config) {
  const body = await request(`/stores`, config);
  return {connected:true, store: body.result || body};
}


function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function getOption(item, wantedNames) {
  const wanted = wantedNames.map(name => name.toLowerCase());

  for (const option of item.options || []) {
    const name = String(option.name || option.Name || '').trim().toLowerCase();
    if (wanted.includes(name)) {
      return String(option.value || option.Value || '').trim();
    }
  }

  return '';
}

function itemReference(item, index) {
  const sku = String(item.sku || `ITEM-${index + 1}`).trim();
  const size = getOption(item, ['size']);
  const color = getOption(item, ['color', 'colour']);

  return [sku, size, color].filter(Boolean).join(' | ').slice(0, 180);
}

function buildShipStationNotes(order) {
  const lines = [
    `ShipStation Order: ${order.orderNumber || order.orderId}`,
    `ShipStation Order ID: ${order.orderId}`,
    '',
    'ORIGINAL ITEMS — replace each placeholder before confirming:',
    ''
  ];

  for (const [index, item] of (order.items || []).entries()) {
    const size = getOption(item, ['size']);
    const color = getOption(item, ['color', 'colour']);

    lines.push(`${index + 1}. ${Number(item.quantity || 0)}x ${item.name || 'Unnamed item'}`);
    if (item.sku) lines.push(`SKU: ${item.sku}`);
    if (size) lines.push(`Size: ${size}`);
    if (color) lines.push(`Color: ${color}`);
    if (item.imageUrl) lines.push(`Image: ${item.imageUrl}`);

    for (const option of item.options || []) {
      const name = String(option.name || option.Name || '').trim();
      const value = String(option.value || option.Value || '').trim();
      if (!name || !value) continue;
      if (['size', 'color', 'colour'].includes(name.toLowerCase())) continue;
      lines.push(`${name}: ${value}`);
    }

    lines.push('');
  }

  return lines.join('\n').slice(0, 9500);
}

export function buildPrintfulOrder(shipstationOrder, config) {
  const address = shipstationOrder.shipTo || {};

  return {
    external_id: String(shipstationOrder.orderNumber || shipstationOrder.orderId),
    shipping: 'STANDARD',
    recipient: compact({
      name: address.name,
      company: address.company,
      address1: address.street1,
      address2: address.street2,
      city: address.city,
      state_code: address.state,
      country_code: address.country,
      zip: address.postalCode,
      phone: address.phone,
      email: shipstationOrder.customerEmail
    }),
    items: (shipstationOrder.items || []).map((item, index) => ({
      // Printful still displays the placeholder product title/image/size.
      // This reference carries the original SKU, size and color beside the line item.
      external_id: itemReference(item, index),
      sync_variant_id: Number(config.printfulPlaceholderSyncVariantId),
      quantity: Math.max(1, Number(item.quantity || 1))
    })),
    retail_costs: {
      currency: shipstationOrder.orderTotal?.currency || 'USD'
    },
    gift: {
      subject: `ShipStation Order ${shipstationOrder.orderNumber || shipstationOrder.orderId}`,
      message: buildShipStationNotes(shipstationOrder)
    }
  };
}

export async function findByExternalId(externalId, config) {
  try {
    const body = await request(`/orders/@${encodeURIComponent(externalId)}`, config);
    return body.result || null;
  } catch (error) {
    if (String(error.message).includes('404')) return null;
    throw error;
  }
}

export async function createOrder(payload, config) {
  const confirm = config.printfulMode === 'live' ? 'true' : 'false';
  const body = await request(`/orders?confirm=${confirm}`, config, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return body.result || body;
}
