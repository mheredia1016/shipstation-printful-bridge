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

    printfulToken: validateSecrets ? required('PRINTFUL_API_TOKEN') : process.env.PRINTFUL_API_TOKEN,
    printfulMode: mode,
    printfulOrderSuffix: process.env.PRINTFUL_ORDER_SUFFIX || '',
    printfulPlaceholderSyncVariantId: process.env.PRINTFUL_PLACEHOLDER_SYNC_VARIANT_ID || '',
    printfulUseCustomItems:
      String(process.env.PRINTFUL_USE_CUSTOM_ITEMS || 'false').toLowerCase() === 'true',
    printfulCustomCatalogVariantId: process.env.PRINTFUL_CUSTOM_CATALOG_VARIANT_ID || '',
    printfulCustomProductId: process.env.PRINTFUL_CUSTOM_PRODUCT_ID || '438',
    printfulCustomColor: process.env.PRINTFUL_CUSTOM_COLOR || 'Black',
    printfulFallbackColor: process.env.PRINTFUL_FALLBACK_COLOR || 'Black',
    printfulCustomFileId: process.env.PRINTFUL_CUSTOM_FILE_ID || '',
    printfulUseProductImageAsPrintFile:
      String(process.env.PRINTFUL_USE_PRODUCT_IMAGE_AS_PRINT_FILE || 'false').toLowerCase() === 'true',
    printfulReviewPrefix: process.env.PRINTFUL_REVIEW_PREFIX || '⚠ REVIEW REQUIRED - ',
    printfulSkuSource: (process.env.PRINTFUL_SKU_SOURCE || 'old_sku').trim().toLowerCase(),
    printfulPrefixTitleWithSku:
      String(process.env.PRINTFUL_PREFIX_TITLE_WITH_SKU || 'true').toLowerCase() === 'true',
    printfulUseShipstationPreview:
      String(process.env.PRINTFUL_USE_SHIPSTATION_PREVIEW || 'true').toLowerCase() === 'true',

    runOnStart: String(process.env.RUN_ON_START || 'true').toLowerCase() === 'true',
    pollIntervalMinutes: integer('POLL_INTERVAL_MINUTES', 10),
    adminToken: process.env.ADMIN_TOKEN || '',
    stateFile: process.env.STATE_FILE || './data/state.json'
  };
}
