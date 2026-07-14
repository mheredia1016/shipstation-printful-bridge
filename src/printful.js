const BASE_URL = 'https://api.printful.com';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after');

  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(1000, date - Date.now());
  }

  // 2s, 4s, 8s, 16s, 30s, 30s...
  return Math.min(30000, 2000 * (2 ** attempt));
}

async function request(path, config, options = {}) {
  const maxRetries = Math.max(1, Number(config.apiMaxRetries || 6));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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

    if (response.status === 429 && attempt < maxRetries) {
      const delay = retryDelayMs(response, attempt);
      console.warn(
        `Printful 429 on ${path}. Retrying in ${Math.round(delay / 1000)}s ` +
        `(attempt ${attempt + 1}/${maxRetries}).`
      );
      await sleep(delay);
      continue;
    }

    if (!response.ok || (body.code && Number(body.code) >= 400)) {
      throw new Error(`Printful ${response.status}: ${JSON.stringify(body).slice(0, 1600)}`);
    }

    return body;
  }

  throw new Error(`Printful request failed after ${maxRetries} retries: ${path}`);
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


function getOldSku(item) {
  return getOption(item, ['old sku', 'old_sku', 'oldsku']);
}

function chooseVisibleSku(item, config) {
  const shopifySku = String(item.sku || '').trim();
  const oldSku = getOldSku(item);

  switch (config.printfulSkuSource) {
    case 'shopify':
      return shopifySku;
    case 'both':
      if (oldSku && shopifySku) return `${oldSku} (${shopifySku})`;
      return oldSku || shopifySku;
    case 'old_sku':
    default:
      return oldSku || shopifySku;
  }
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

export async function buildPrintfulOrder(shipstationOrder, config) {
  const address = shipstationOrder.shipTo || {};
  const originalOrderNumber = String(shipstationOrder.orderNumber || shipstationOrder.orderId);
  const safeSuffix = String(config.printfulOrderSuffix || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 20);
  const safePrefix = String(config.printfulExternalIdPrefix || 'SS')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 10);

  // Printful can reject long or complex external IDs.
  // Use the unique numeric ShipStation order ID with a short optional suffix.
  const uniqueExternalId = `${safePrefix}${shipstationOrder.orderId}${safeSuffix}`;

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
    items: await Promise.all(realItems.map(async (item, index) => {
      const originalTitle = String(item.name || `Item ${index + 1}`).trim();
      const sku = chooseVisibleSku(item, config);
      const baseTitle =
        config.printfulPrefixTitleWithSku && sku
          ? `${sku} • ${originalTitle}`
          : originalTitle;
      const title = `${config.printfulReviewPrefix || ''}${baseTitle}`.slice(0, 180);
      const quantity = Math.max(1, Number(item.quantity || 1));
      const reference = itemReference(item, index);

      if (config.printfulUseCustomItems) {
        const variantId = await resolveCatalogVariantId(item, config);

        const files = [];

        if (config.printfulUseProductImageAsPrintFile) {
          if (!item.imageUrl) {
            throw new Error(`No ShipStation imageUrl found for SKU ${item.sku || '(no SKU)'}.`);
          }

          files.push({
            // User-approved test mode: Shopify mockup becomes the default print file.
            type: 'default',
            url: String(item.imageUrl).trim()
          });
        } else {
          if (!config.printfulCustomFileId) {
            throw new Error(
              'PRINTFUL_CUSTOM_FILE_ID is required when product images are not used as print files.'
            );
          }

          files.push({
            id: Number(config.printfulCustomFileId),
            type: 'default'
          });
        }

        if (
          !config.printfulUseProductImageAsPrintFile &&
          config.printfulUseShipstationPreview &&
          item.imageUrl
        ) {
          files.push({
            type: 'preview',
            url: String(item.imageUrl).trim()
          });
        }

        return {
          external_id: reference,
          variant_id: variantId,
          quantity,
          name: title,
          sku,
          files
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
    })),
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
