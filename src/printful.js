import {
  getArtworkFileId,
  loadArtworkMap,
  saveArtworkMap,
  setArtworkFileId
} from './artwork-map.js';

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
        ...(config.printfulStoreId
          ? { 'X-PF-Store-ID': String(config.printfulStoreId) }
          : {}),
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


let catalogVariantCache = null;

function normalizeSize(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

  const aliases = {
    small: 'S',
    s: 'S',
    medium: 'M',
    m: 'M',
    large: 'L',
    l: 'L',
    'x-large': 'XL',
    xlarge: 'XL',
    xl: 'XL',
    'xx-large': '2XL',
    xxlarge: '2XL',
    '2xl': '2XL',
    'xxx-large': '3XL',
    xxxlarge: '3XL',
    '3xl': '3XL',
    'xxxx-large': '4XL',
    xxxxlarge: '4XL',
    '4xl': '4XL',
    'xxxxx-large': '5XL',
    xxxxxlarge: '5XL',
    '5xl': '5XL'
  };

  return aliases[raw] || String(value || '').trim().toUpperCase();
}

async function getCatalogVariants(config) {
  if (catalogVariantCache) return catalogVariantCache;

  const body = await request(
    `/products/${encodeURIComponent(config.printfulCustomProductId)}`,
    config
  );

  const result = body.result || body;
  const variants = Array.isArray(result.variants) ? result.variants : [];

  if (!variants.length) {
    throw new Error(
      `No catalog variants returned for Printful product ${config.printfulCustomProductId}.`
    );
  }

  catalogVariantCache = variants;
  return variants;
}

async function resolveCatalogVariantId(item, config) {
  const orderedSize = normalizeSize(
    getOption(item, ['size', 'size property'])
  );

  const orderedColor = String(
    getOption(item, ['color', 'colour']) ||
    config.printfulFallbackColor ||
    'Black'
  ).trim();

  if (!orderedSize) {
    if (config.printfulCustomCatalogVariantId) {
      return Number(config.printfulCustomCatalogVariantId);
    }

    throw new Error(
      `No size found for SKU ${item.sku || '(no SKU)'}.`
    );
  }

  const variants = await getCatalogVariants(config);
  const wantedColor = orderedColor.toLowerCase();

  let match = variants.find(variant => {
    const size = normalizeSize(variant.size);
    const color = String(variant.color || '').trim().toLowerCase();

    return size === orderedSize && color === wantedColor;
  });

  if (!match && config.printfulFallbackColor) {
    const fallbackColor = String(config.printfulFallbackColor)
      .trim()
      .toLowerCase();

    match = variants.find(variant => {
      const size = normalizeSize(variant.size);
      const color = String(variant.color || '').trim().toLowerCase();

      return size === orderedSize && color === fallbackColor;
    });
  }

  if (!match) {
    throw new Error(
      `No catalog variant found for ${orderedColor} / ${orderedSize} ` +
      `on Printful product ${config.printfulCustomProductId} ` +
      `(SKU ${item.sku || '(no SKU)'}).`
    );
  }

  return Number(match.id);
}


let syncedStoreProductCache = {
  products: null,
  details: new Map()
};

function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function itemMatchesSyncedProductPilot(item, config) {
  const wantedSku = normalizedText(config.printfulSyncedProductTestSku);
  if (!wantedSku) return false;

  const oldSku = normalizedText(getOldSku(item));
  const currentSku = normalizedText(item.sku);
  return oldSku === wantedSku || currentSku === wantedSku;
}

async function listAllStoreProducts(config) {
  if (Array.isArray(syncedStoreProductCache.products)) {
    return syncedStoreProductCache.products;
  }

  const products = [];

  for (let page = 0; page < config.printfulProductScanMaxPages; page += 1) {
    const offset = page * 100;
    const body = await listStoreProductsPage(config, offset);
    const rows = Array.isArray(body.result) ? body.result : [];
    products.push(...rows);

    const total = Number(body?.paging?.total || 0);
    if (rows.length < 100 || (total && offset + rows.length >= total)) break;

    if (config.printfulRequestDelayMs > 0) {
      await sleep(config.printfulRequestDelayMs);
    }
  }

  syncedStoreProductCache.products = products;
  return products;
}

async function getCachedStoreProduct(productId, config) {
  const key = String(productId);
  if (syncedStoreProductCache.details.has(key)) {
    return syncedStoreProductCache.details.get(key);
  }

  const details = await getStoreProduct(productId, config);
  syncedStoreProductCache.details.set(key, details);
  return details;
}

function storeProductName(product) {
  return String(
    product?.sync_product?.name ||
    product?.name ||
    product?.title ||
    ''
  ).trim();
}


function productSkuPrefix(product) {
  const name = storeProductName(product);
  const separator = name.indexOf('|');
  if (separator < 1) return '';
  return normalizedText(name.slice(0, separator));
}

async function findStoreProductBySkuPrefix(item, config) {
  // Old SKU is authoritative. Current ShipStation SKU is fallback only.
  const oldSku = normalizedText(getOldSku(item));
  const currentSku = normalizedText(item.sku);
  const wantedSkus = [...new Set([oldSku, currentSku].filter(Boolean))];

  if (!wantedSkus.length) return null;

  const products = await listAllStoreProducts(config);

  for (const wantedSku of wantedSkus) {
    const matches = products.filter(product => productSkuPrefix(product) === wantedSku);

    if (matches.length > 1) {
      throw new Error(
        `Multiple Printful products use SKU prefix ${wantedSku}: ` +
        matches.map(storeProductName).join(', ')
      );
    }

    if (matches.length === 1) {
      return {
        product: await getCachedStoreProduct(matches[0].id, config),
        matchedSku: wantedSku,
        matchedBy: wantedSku === oldSku ? 'old_sku' : 'current_sku'
      };
    }
  }

  return null;
}

function descriptorHasSize(descriptor, orderedSize) {
  const d = String(descriptor || '').toUpperCase();
  const size = String(orderedSize || '').toUpperCase();
  const tokens = d.split(/[^A-Z0-9]+/).filter(Boolean);
  return tokens.includes(size);
}

async function resolveSyncedVariantFromProduct(item, product, config) {
  const productName = String(product?.sync_product?.name || product?.name || '(unnamed product)');
  const syncVariants = Array.isArray(product.sync_variants) ? product.sync_variants : [];

  if (!syncVariants.length) {
    throw new Error(`Printful product ${productName} has no sync variants.`);
  }

  const orderedSize = normalizeSize(getOption(item, ['size', 'size property']));
  const orderedColor = normalizedText(
    getOption(item, ['color', 'colour']) ||
    config.printfulFallbackColor ||
    'Black'
  );

  if (!orderedSize) {
    throw new Error(
      `No size found for ${getOldSku(item) || item.sku || '(no SKU)'} on ${productName}.`
    );
  }

  // Most Printful sync variants expose a readable variant name. Use it first,
  // which lets this work even when different synced products use different
  // garment catalog IDs.
  let match = syncVariants.find(syncVariant => {
    const descriptor = String(
      syncVariant?.name ||
      syncVariant?.variant_name ||
      ''
    );
    if (!descriptor) return false;
    const hasSize = descriptorHasSize(descriptor, orderedSize);
    const hasColor = !orderedColor || normalizedText(descriptor).includes(orderedColor);
    return hasSize && hasColor;
  });

  let catalog = null;

  // Compatibility fallback for the existing Gildan blank configuration.
  if (!match) {
    const catalogVariants = await getCatalogVariants(config);
    const catalogById = new Map(
      catalogVariants.map(variant => [Number(variant.id), variant])
    );

    const candidates = syncVariants.map(syncVariant => ({
      syncVariant,
      catalog: catalogById.get(Number(syncVariant.variant_id))
    }));

    let resolved = candidates.find(row => {
      if (!row.catalog) return false;
      return normalizeSize(row.catalog.size) === orderedSize &&
        normalizedText(row.catalog.color) === orderedColor;
    });

    if (!resolved && config.printfulFallbackColor) {
      const fallbackColor = normalizedText(config.printfulFallbackColor);
      resolved = candidates.find(row => {
        if (!row.catalog) return false;
        return normalizeSize(row.catalog.size) === orderedSize &&
          normalizedText(row.catalog.color) === fallbackColor;
      });
    }

    if (resolved) {
      match = resolved.syncVariant;
      catalog = resolved.catalog;
    }
  }

  if (!match) {
    const available = syncVariants
      .map(v => v.name || v.variant_name || `variant_id=${v.variant_id}`)
      .join(', ');
    throw new Error(
      `No synced Printful variant found for ${orderedColor || 'unknown color'} / ` +
      `${orderedSize} on ${productName}. Available: ${available || 'none'}.`
    );
  }

  return {
    syncVariantId: Number(match.id),
    catalogVariantId: Number(match.variant_id),
    productId: Number(product?.sync_product?.id || product?.id || 0) || null,
    productName,
    color: catalog?.color || getOption(item, ['color', 'colour']) || config.printfulFallbackColor || '',
    size: catalog?.size ? normalizeSize(catalog.size) : orderedSize
  };
}

async function resolveAutomaticSyncedStoreVariant(item, config) {
  const found = await findStoreProductBySkuPrefix(item, config);
  if (!found) return null;

  const resolved = await resolveSyncedVariantFromProduct(item, found.product, config);
  return {
    ...resolved,
    matchedSku: found.matchedSku,
    matchedBy: found.matchedBy
  };
}

async function findStoreProductByName(productName, config) {
  const wanted = normalizedText(productName);
  if (!wanted) {
    throw new Error('PRINTFUL_SYNCED_PRODUCT_TEST_NAME is not configured.');
  }

  const products = await listAllStoreProducts(config);

  let match = products.find(product =>
    normalizedText(storeProductName(product)) === wanted
  );

  // Defensive fallback in case Printful returns only a shortened/altered
  // title in the list response. We still require one unambiguous match.
  if (!match) {
    const partials = products.filter(product => {
      const name = normalizedText(storeProductName(product));
      return name && (name.includes(wanted) || wanted.includes(name));
    });
    if (partials.length === 1) match = partials[0];
  }

  if (!match) {
    throw new Error(
      `Printful store product not found: ${productName}. ` +
      `Check that it exists in Printful store ${config.printfulStoreId || '(token default)'}.`
    );
  }

  return getCachedStoreProduct(match.id, config);
}

async function resolveSyncedStoreVariant(item, config) {
  const product = await findStoreProductByName(
    config.printfulSyncedProductTestName,
    config
  );

  const syncVariants = Array.isArray(product.sync_variants)
    ? product.sync_variants
    : [];

  if (!syncVariants.length) {
    throw new Error(
      `Printful product ${config.printfulSyncedProductTestName} has no sync variants.`
    );
  }

  const orderedSize = normalizeSize(getOption(item, ['size', 'size property']));
  const orderedColor = normalizedText(
    getOption(item, ['color', 'colour']) ||
    config.printfulFallbackColor ||
    'Black'
  );

  if (!orderedSize) {
    throw new Error(
      `No size found for synced-product pilot SKU ${getOldSku(item) || item.sku || '(no SKU)'}.`
    );
  }

  // The sync variant points to a Printful catalog variant_id. Reuse the
  // existing catalog data to identify the exact Black/size variant.
  const catalogVariants = await getCatalogVariants(config);
  const catalogById = new Map(
    catalogVariants.map(variant => [Number(variant.id), variant])
  );

  const candidates = syncVariants.map(syncVariant => {
    const catalog = catalogById.get(Number(syncVariant.variant_id));
    return { syncVariant, catalog };
  });

  let match = candidates.find(({ catalog }) => {
    if (!catalog) return false;
    return normalizeSize(catalog.size) === orderedSize &&
      normalizedText(catalog.color) === orderedColor;
  });

  if (!match && config.printfulFallbackColor) {
    const fallbackColor = normalizedText(config.printfulFallbackColor);
    match = candidates.find(({ catalog }) => {
      if (!catalog) return false;
      return normalizeSize(catalog.size) === orderedSize &&
        normalizedText(catalog.color) === fallbackColor;
    });
  }

  if (!match) {
    const available = candidates
      .filter(({ catalog }) => catalog)
      .map(({ catalog }) => `${catalog.color} / ${normalizeSize(catalog.size)}`)
      .join(', ');

    throw new Error(
      `No synced Printful variant found for ${orderedColor || 'unknown color'} / ` +
      `${orderedSize} on ${config.printfulSyncedProductTestName}. ` +
      `Available: ${available || 'none could be resolved'}.`
    );
  }

  return {
    syncVariantId: Number(match.syncVariant.id),
    catalogVariantId: Number(match.syncVariant.variant_id),
    productId: Number(product?.sync_product?.id || product?.id || 0) || null,
    productName: String(product?.sync_product?.name || config.printfulSyncedProductTestName),
    color: match.catalog?.color || '',
    size: normalizeSize(match.catalog?.size)
  };
}



let storeArtworkScanCache = {
  completedAt: 0,
  scanned: false
};

function normalizeArtworkSku(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.png$/i, '');
}

async function listStoreProductsPage(config, offset) {
  return request(
    `/store/products?limit=100&offset=${offset}`,
    config
  );
}

async function getStoreProduct(productId, config) {
  const body = await request(
    `/store/products/${encodeURIComponent(productId)}`,
    config
  );
  return body.result || body;
}

async function scanAttachedStoreArtwork(config, neededSkus = []) {
  const needed = new Set(
    neededSkus.map(normalizeArtworkSku).filter(Boolean)
  );

  const map = await loadArtworkMap(config.artworkMapFile);
  for (const sku of [...needed]) {
    if (getArtworkFileId(map, sku)) needed.delete(sku);
  }

  if (!needed.size) return map;

  const oneHour = 60 * 60 * 1000;
  if (
    storeArtworkScanCache.scanned &&
    Date.now() - storeArtworkScanCache.completedAt < oneHour
  ) {
    return map;
  }

  for (
    let page = 0;
    page < config.printfulProductScanMaxPages && needed.size;
    page += 1
  ) {
    const offset = page * 100;
    const body = await listStoreProductsPage(config, offset);
    const products = Array.isArray(body.result) ? body.result : [];

    for (const product of products) {
      if (!needed.size) break;

      const details = await getStoreProduct(product.id, config);
      const variants = Array.isArray(details.sync_variants)
        ? details.sync_variants
        : [];

      for (const variant of variants) {
        for (const file of variant.files || []) {
          const filenameSku = normalizeArtworkSku(file.filename);
          if (!filenameSku || !needed.has(filenameSku)) continue;
          if (!file.id || (file.status && file.status !== 'ok')) continue;

          setArtworkFileId(map, filenameSku, file.id, 'printful-store-product');
          needed.delete(filenameSku);
        }
      }

      if (config.printfulRequestDelayMs > 0) {
        await sleep(config.printfulRequestDelayMs);
      }
    }

    const total = Number(body?.paging?.total || 0);
    if (products.length < 100 || (total && offset + products.length >= total)) {
      break;
    }
  }

  await saveArtworkMap(config.artworkMapFile, map);
  storeArtworkScanCache = {
    scanned: true,
    completedAt: Date.now()
  };

  return map;
}

async function resolveArtworkFile(item, config) {
  const oldSku = getOldSku(item);
  const currentSku = String(item.sku || '').trim();
  const lookupSku = oldSku || currentSku;

  if (!lookupSku) {
    throw new Error(
      `No old SKU or current SKU found for ${item.name || 'item'}.`
    );
  }

  let map = await loadArtworkMap(config.artworkMapFile);
  let fileId = getArtworkFileId(map, lookupSku);

  if (!fileId) {
    map = await scanAttachedStoreArtwork(config, [lookupSku]);
    fileId = getArtworkFileId(map, lookupSku);
  }

  if (fileId) {
    return { type: 'id', id: fileId };
  }

  if (
    config.printfulMissingArtworkBehavior === 'placeholder' &&
    config.printfulCustomFileId
  ) {
    return { type: 'id', id: Number(config.printfulCustomFileId) };
  }

  if (
    config.printfulMissingArtworkBehavior === 'mockup' &&
    item.imageUrl
  ) {
    return {
      type: 'url',
      url: String(item.imageUrl).trim()
    };
  }

  throw new Error(
    `Artwork mapping missing for ${lookupSku}. ` +
    `The removed Printful /files endpoint cannot search unattached library files. ` +
    `Add the file ID through /api/artwork-map or attach ${lookupSku}.png ` +
    `to a Printful store product once so the bridge can discover it.`
  );
}

export async function discoverArtworkMappings(skus, config) {
  return scanAttachedStoreArtwork(config, skus);
}

export async function verifyPrintful(config) {
  const body = await request('/stores', config);
  return {
    connected: true,
    store: body.result || body
  };
}

export async function inspectSyncedProductTest(config) {
  if (!config.printfulSyncedProductTestSku || !config.printfulSyncedProductTestName) {
    return {
      configured: false,
      testSku: config.printfulSyncedProductTestSku || '',
      productName: config.printfulSyncedProductTestName || '',
      message: 'Set PRINTFUL_SYNCED_PRODUCT_TEST_SKU and PRINTFUL_SYNCED_PRODUCT_TEST_NAME.'
    };
  }

  const product = await findStoreProductByName(
    config.printfulSyncedProductTestName,
    config
  );
  const catalogVariants = await getCatalogVariants(config);
  const catalogById = new Map(
    catalogVariants.map(variant => [Number(variant.id), variant])
  );

  return {
    configured: true,
    testSku: config.printfulSyncedProductTestSku,
    productName: product?.sync_product?.name || config.printfulSyncedProductTestName,
    syncProductId: product?.sync_product?.id || product?.id || null,
    variants: (product.sync_variants || []).map(variant => {
      const catalog = catalogById.get(Number(variant.variant_id));
      return {
        syncVariantId: Number(variant.id),
        catalogVariantId: Number(variant.variant_id),
        color: catalog?.color || null,
        size: catalog ? normalizeSize(catalog.size) : null,
        synced: variant.synced ?? null
      };
    })
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

export async function buildPrintfulOrder(group, config) {
  const primaryOrder = group.orders[0];
  const address = primaryOrder.shipTo || {};
  const originalOrderNumber = String(group.orderNumber);
  const safeSuffix = String(config.printfulOrderSuffix || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 16);

  // Final production behavior: visible Printful order number matches ShipStation.
  const externalId = `${originalOrderNumber}${safeSuffix}`;

  const realItems = group.orders
    .flatMap(order => order.items || [])
    .filter(isRealProductItem);

  if (realItems.length === 0) {
    throw new Error(`ShipStation order ${originalOrderNumber} has no usable product items.`);
  }

  const notesOrder = {
    ...primaryOrder,
    orderNumber: originalOrderNumber,
    orderId: group.shipstationOrderIds.join(', '),
    items: realItems
  };

  return {
    external_id: externalId,
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
      email: primaryOrder.customerEmail
    }),
    items: await Promise.all(realItems.map(async (item, index) => {
      const originalTitle = String(item.name || `Item ${index + 1}`).trim();

      // Automatic synced-product matching.
      // Printful naming convention: OLD-SKU | PRODUCT NAME
      // Old SKU is checked first; current ShipStation SKU is fallback.
      try {
        const automatic = await resolveAutomaticSyncedStoreVariant(item, config);
        if (automatic) {
          console.log(
            `[SYNCED PRODUCT AUTO] ${originalOrderNumber} | ` +
            `${automatic.matchedSku} (${automatic.matchedBy}) -> ${automatic.productName} | ` +
            `${automatic.color} / ${automatic.size} | sync_variant_id=${automatic.syncVariantId}`
          );

          return {
            external_id: itemReference(item, index),
            sync_variant_id: automatic.syncVariantId,
            quantity: Math.max(1, Number(item.quantity || 1))
          };
        }
      } catch (error) {
        if (!config.printfulSyncedProductFallback) throw error;
        console.warn(
          `[SYNCED PRODUCT AUTO FALLBACK] ${originalOrderNumber} | ` +
          `${getOldSku(item) || item.sku || '(no SKU)'} | ${error.message}`
        );
      }

      // Backward-compatible pilot for the existing aew6099 test product.
      // This can be removed later after that Printful product is renamed to
      // "aew6099 | ...".
      if (itemMatchesSyncedProductPilot(item, config)) {
        try {
          const synced = await resolveSyncedStoreVariant(item, config);
          console.log(
            `[SYNCED PRODUCT] ${originalOrderNumber} | ` +
            `${getOldSku(item) || item.sku} -> ${synced.productName} | ` +
            `${synced.color} / ${synced.size} | sync_variant_id=${synced.syncVariantId}`
          );

          return {
            external_id: itemReference(item, index),
            sync_variant_id: synced.syncVariantId,
            quantity: Math.max(1, Number(item.quantity || 1))
          };
        } catch (error) {
          if (!config.printfulSyncedProductFallback) throw error;
          console.warn(
            `[SYNCED PRODUCT FALLBACK] ${originalOrderNumber} | ` +
            `${getOldSku(item) || item.sku || '(no SKU)'} | ${error.message}`
          );
        }
      }

      const originalTitleForCustomItem = originalTitle;
      const sku = chooseVisibleSku(item, config);
      const baseTitle =
        config.printfulPrefixTitleWithSku && sku
          ? `${sku} • ${originalTitleForCustomItem}`
          : originalTitleForCustomItem;
      const title = `${config.printfulReviewPrefix || ''}${baseTitle}`.slice(0, 180);
      const quantity = Math.max(1, Number(item.quantity || 1));
      const reference = itemReference(item, index);
      const variantId = await resolveCatalogVariantId(item, config);

      const files = [];
      let mappedArtworkFileId = null;

      if (config.printfulUseArtworkMap) {
        const artworkMap = await loadArtworkMap(config.artworkMapFile);
        const oldSku = getOldSku(item);
        const currentSku = String(item.sku || '').trim();
        mappedArtworkFileId =
          getArtworkFileId(artworkMap, oldSku) ||
          getArtworkFileId(artworkMap, currentSku);
      }

      if (mappedArtworkFileId) {
        files.push({
          id: Number(mappedArtworkFileId),
          type: 'default'
        });
      } else if (config.printfulUseLibraryArtwork) {
        const artwork = await resolveArtworkFile(item, config);
        if (artwork.type === 'id') {
          files.push({ id: artwork.id, type: 'default' });
        } else {
          files.push({ url: artwork.url, type: 'default' });
        }
      } else if (config.printfulUseProductImageAsPrintFile) {
        if (!item.imageUrl) {
          throw new Error(`No ShipStation imageUrl found for SKU ${item.sku || '(no SKU)'}.`);
        }
        files.push({ type: 'default', url: String(item.imageUrl).trim() });
      } else if (config.printfulCustomFileId) {
        files.push({ id: Number(config.printfulCustomFileId), type: 'default' });
      } else {
        throw new Error('A default Printful file is required.');
      }

      return {
        external_id: reference,
        variant_id: variantId,
        quantity,
        name: title,
        sku,
        files
      };
    })),
    gift: {
      subject: `ShipStation Order ${originalOrderNumber}`,
      message: buildShipStationNotes(notesOrder)
    }
  };
}


export async function getPrintfulShipments(orderId, config) {
  const body = await request(
    `/v2/orders/${encodeURIComponent(orderId)}/shipments`,
    config
  );

  // Printful v2 returns shipment rows in `data`.
  if (Array.isArray(body?.data)) return body.data;

  // Defensive fallbacks in case the response shape changes.
  if (Array.isArray(body?.result)) return body.result;
  if (Array.isArray(body?.shipments)) return body.shipments;

  return [];
}

export async function getPrintfulOrder(orderId, config) {
  const body = await request(`/orders/${encodeURIComponent(orderId)}`, config);
  return body.result || body;
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

export async function updateDraftOrder(orderIdOrExternalId, payload, config) {
  const raw = String(orderIdOrExternalId || '').trim();
  if (!raw) throw new Error('Printful order ID or external ID is required.');

  const id = raw.startsWith('@') || /^\d+$/.test(raw) ? raw : `@${raw}`;
  const body = await request(`/orders/${encodeURIComponent(id)}?confirm=false`, config, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  return body.result || body;
}


export async function getPrintfulWebhookConfig(config) {
  return request('/v2/webhooks', config);
}

export async function setupPrintfulShipmentWebhook(webhookUrl, config) {
  const body = await request('/v2/webhooks', config, {
    method: 'POST',
    body: JSON.stringify({
      default_url: webhookUrl,
      events: [
        {
          type: 'shipment_sent'
        }
      ]
    })
  });

  return body;
}
