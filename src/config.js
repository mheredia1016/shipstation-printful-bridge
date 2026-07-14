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
    shipstationOrderStatus: process.env.SHIPSTATION_ORDER_STATUS || 'awaiting_shipment',
    customFieldValue: process.env.SHIPSTATION_CUSTOM_FIELD_VALUE || 'Printful',
    pageSize: Math.min(integer('SHIPSTATION_PAGE_SIZE', 100), 500),
    maxPages: integer('SHIPSTATION_MAX_PAGES', 10),

    printfulToken: validateSecrets ? required('PRINTFUL_API_TOKEN') : process.env.PRINTFUL_API_TOKEN,
    printfulStoreId: process.env.PRINTFUL_STORE_ID || '',
    printfulMode: mode,

    runOnStart: String(process.env.RUN_ON_START || 'true').toLowerCase() === 'true',
    pollIntervalMinutes: integer('POLL_INTERVAL_MINUTES', 10),
    adminToken: process.env.ADMIN_TOKEN || '',

    mappingFile: process.env.MAPPING_FILE || './data/mappings.csv',
    stateFile: process.env.STATE_FILE || './data/state.json'
  };
}
