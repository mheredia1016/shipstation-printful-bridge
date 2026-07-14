function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function boolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

export function getConfig({ validateSecrets = true } = {}) {
  const mode = (process.env.PRINTFUL_MODE || 'preview').trim().toLowerCase();
  if (!['preview', 'draft', 'live'].includes(mode)) {
    throw new Error('PRINTFUL_MODE must be preview, draft, or live.');
  }

  return {
    port: integer('PORT', 8080),

    shipstationApiKey: validateSecrets ? required('SHIPSTATION_API_KEY') : process.env.SHIPSTATION_API_KEY,
    shipstationApiSecret: validateSecrets ? required('SHIPSTATION_API_SECRET') : process.env.SHIPSTATION_API_SECRET,
    shipstationStoreId: required('SHIPSTATION_STORE_ID'),
    shipstationOrderStatus: process.env.SHIPSTATION_ORDER_STATUS || 'awaiting_shipment',
    customFieldValue: process.env.SHIPSTATION_CUSTOM_FIELD_VALUE || 'Printful',
    pageSize: Math.min(integer('SHIPSTATION_PAGE_SIZE', 100), 500),
    maxPages: integer('SHIPSTATION_MAX_PAGES', 10),
    shipstationNotifyCustomer: boolean('SHIPSTATION_NOTIFY_CUSTOMER', false),
    shipstationNotifySalesChannel: boolean('SHIPSTATION_NOTIFY_SALES_CHANNEL', true),
    shipstationFallbackCarrierCode: process.env.SHIPSTATION_FALLBACK_CARRIER_CODE || 'other',

    printfulToken: validateSecrets ? required('PRINTFUL_API_TOKEN') : process.env.PRINTFUL_API_TOKEN,
    printfulMode: mode,
    printfulOrderSuffix: process.env.PRINTFUL_ORDER_SUFFIX || '',
    printfulRequestDelayMs: integer('PRINTFUL_REQUEST_DELAY_MS', 1200),
    apiMaxRetries: integer('API_MAX_RETRIES', 6),
    printfulUseCustomItems: boolean('PRINTFUL_USE_CUSTOM_ITEMS', true),
    printfulCustomCatalogVariantId: process.env.PRINTFUL_CUSTOM_CATALOG_VARIANT_ID || '',
    printfulCustomProductId: process.env.PRINTFUL_CUSTOM_PRODUCT_ID || '438',
    printfulFallbackColor: process.env.PRINTFUL_FALLBACK_COLOR || 'Black',
    printfulCustomFileId: process.env.PRINTFUL_CUSTOM_FILE_ID || '',
    printfulUseProductImageAsPrintFile: boolean('PRINTFUL_USE_PRODUCT_IMAGE_AS_PRINT_FILE', false),
    printfulUseLibraryArtwork: boolean('PRINTFUL_USE_LIBRARY_ARTWORK', true),
    printfulArtworkExtension: process.env.PRINTFUL_ARTWORK_EXTENSION || '.png',
    printfulFilePageSize: Math.min(integer('PRINTFUL_FILE_PAGE_SIZE', 100), 100),
    printfulFileMaxPages: integer('PRINTFUL_FILE_MAX_PAGES', 100),
    printfulMissingArtworkBehavior:
      (process.env.PRINTFUL_MISSING_ARTWORK_BEHAVIOR || 'fail').trim().toLowerCase(),
    printfulReviewPrefix: process.env.PRINTFUL_REVIEW_PREFIX || '',
    printfulSkuSource: (process.env.PRINTFUL_SKU_SOURCE || 'old_sku').trim().toLowerCase(),
    printfulPrefixTitleWithSku: boolean('PRINTFUL_PREFIX_TITLE_WITH_SKU', true),

    runOnStart: boolean('RUN_ON_START', true),
    pollIntervalMinutes: integer('POLL_INTERVAL_MINUTES', 10),
    trackingPollMinutes: integer('TRACKING_POLL_MINUTES', 10),
    adminToken: process.env.ADMIN_TOKEN || '',
    stateFile: process.env.STATE_FILE || '/data/state.json'
  };
}
