const BASE_URL = 'https://api.printful.com';

async function request(path, config, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.printfulToken}`,
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
    throw new Error(`Printful ${response.status}: ${JSON.stringify(body).slice(0, 1600)}`);
  }

  return body;
}

export async function verifyPrintful(config) {
  const body = await request('/stores', config);
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

function isRealProductItem(item) {
  const sku = String(item.sku || '').trim();
  const name = String(item.name || '').trim();

  if (!sku) return false;
  if (/^shop\d+$/i.test(name)) return false;
  if (/^aew[_-]?\d+$/i.test(name)) return false;
  if (/^\d+$/.test(name)) return false;

  return true;
}

function itemReference(item, index) {
  const title = String(item.name || `Item ${index + 1}`).trim();
  const sku = String(item.sku || `ITEM-${index + 1}`).trim();
  const size = getOption(item, ['size', 'size property']);
  const color = getOption(item, ['color', 'colour']);

  return [title, `SKU ${sku}`, size, color]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 180);
}

function buildShipStationNotes(order) {
  const lines = [
    `ShipStation Order Number: ${order.orderNumber || order.orderId}`,
    `ShipStation Order ID: ${order.orderId}`,
    '',
    'ORIGINAL ITEMS — replace each placeholder before confirming:',
    ''
  ];

  for (const [index, item] of (order.items || []).filter(isRealProductItem).entries()) {
    const size = getOption(item, ['size', 'size property']);
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
      if (['size', 'size property', 'color', 'colour'].includes(name.toLowerCase())) continue;
      lines.push(`${name}: ${value}`);
    }

    lines.push('');
  }

  return lines.join('\n').slice(0, 9500);
}

export function buildPrintfulOrder(shipstationOrder, config) {
  const address = shipstationOrder.shipTo || {};
  const originalOrderNumber = String(shipstationOrder.orderNumber || shipstationOrder.orderId);
  const uniqueExternalId =
    `${originalOrderNumber}-${shipstationOrder.orderId}${config.printfulOrderSuffix}`;

  const realItems = (shipstationOrder.items || []).filter(isRealProductItem);
  if (realItems.length === 0) {
    throw new Error(`ShipStation order ${originalOrderNumber} has no usable product items.`);
  }

  return {
    external_id: uniqueExternalId,
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
    items: realItems.map((item, index) => {
      const title = String(item.name || `Item ${index + 1}`).trim();
      const sku = String(item.sku || '').trim();
      const quantity = Math.max(1, Number(item.quantity || 1));
      const reference = itemReference(item, index);

      if (config.printfulUseCustomItems) {
        if (!config.printfulCustomCatalogVariantId) {
          throw new Error('PRINTFUL_CUSTOM_CATALOG_VARIANT_ID is required when PRINTFUL_USE_CUSTOM_ITEMS=true.');
        }
        if (!config.printfulCustomFileId) {
          throw new Error('PRINTFUL_CUSTOM_FILE_ID is required when PRINTFUL_USE_CUSTOM_ITEMS=true.');
        }

        return {
          external_id: reference,
          variant_id: Number(config.printfulCustomCatalogVariantId),
          quantity,
          name: title,
          sku,
          files: [
            {
              id: Number(config.printfulCustomFileId),
              type: 'default'
            }
          ]
        };
      }

      if (!config.printfulPlaceholderSyncVariantId) {
        throw new Error('PRINTFUL_PLACEHOLDER_SYNC_VARIANT_ID is required for synced-placeholder mode.');
      }

      return {
        external_id: reference,
        sync_variant_id: Number(config.printfulPlaceholderSyncVariantId),
        quantity
      };
    }),
    gift: {
      subject: `ShipStation Order ${originalOrderNumber}`,
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
