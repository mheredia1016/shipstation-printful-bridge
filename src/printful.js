const BASE_URL = 'https://api.printful.com';

async function request(path, config, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.printfulToken}`,
      'X-PF-Store-Id': String(config.printfulStoreId),
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
  const body = await request(`/stores/${encodeURIComponent(config.printfulStoreId)}`, config);
  return {
    connected: true,
    store: body.result || body
  };
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

export function buildPrintfulOrder(shipstationOrder, mappedItems) {
  const address = shipstationOrder.shipTo || {};

  return {
    external_id: `shipstation-${shipstationOrder.orderId}`,
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
    items: mappedItems.map(({ item, mapping }) => ({
      external_id: String(item.orderItemId || `${shipstationOrder.orderId}-${item.sku}`),
      variant_id: Number(mapping.printful_variant_id),
      quantity: Number(item.quantity),
      retail_price: item.unitPrice != null ? String(item.unitPrice) : undefined,
      files: [
        mapping.front_art_url ? { type: 'front', url: mapping.front_art_url } : null,
        mapping.back_art_url ? { type: 'back', url: mapping.back_art_url } : null
      ].filter(Boolean)
    }))
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
