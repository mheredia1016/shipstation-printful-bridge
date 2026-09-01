import {
  artworkMapEntries,
  loadArtworkMap,
  saveArtworkMap,
  setArtworkFileId
} from './artwork-map.js';
import express from 'express';
import crypto from 'node:crypto';
import { getConfig } from './config.js';
import { verifyShipStation } from './shipstation.js';
import {
  verifyPrintful,
  inspectSyncedProductTest,
  getPrintfulWebhookConfig,
  setupPrintfulShipmentWebhook
} from './printful.js';
import {
  runImport,
  runTrackingSync,
  getLastRun,
  getLastTrackingRun,
  processPrintfulShipmentWebhook,
  reprocessOneOrder
} from './runner.js';

const config = getConfig();
const app = express();

let statusCache = {
  expiresAt: 0,
  value: null
};

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use((req, res, next) => {
  const origin = req.get('origin');

  if (origin === 'https://www.printful.com') {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Admin-Token'
    );
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});
app.use(express.static('public'));


function verifyPrintfulWebhookSignature(req) {
  if (!config.printfulWebhookSecret) {
    // Allows initial testing before the secret returned by Printful is saved.
    return {
      verified: false,
      reason: 'PRINTFUL_WEBHOOK_SECRET is not configured'
    };
  }

  const signature = String(
    req.get('x-pf-webhook-signature') || ''
  ).trim();

  if (!signature || !req.rawBody) {
    return {
      verified: false,
      reason: 'Missing webhook signature or raw body'
    };
  }

  const key = Buffer.from(config.printfulWebhookSecret, 'hex');
  const expected = crypto
    .createHmac('sha256', key)
    .update(req.rawBody)
    .digest('hex');

  const received = Buffer.from(signature, 'utf8');
  const calculated = Buffer.from(expected, 'utf8');

  if (received.length !== calculated.length) {
    return {
      verified: false,
      reason: 'Signature length mismatch'
    };
  }

  return {
    verified: crypto.timingSafeEqual(received, calculated),
    reason: 'signature check'
  };
}

function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();
  const token = req.get('x-admin-token') || req.query.token;
  if (token !== config.adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: config.printfulMode,
    uptimeSeconds: Math.round(process.uptime()),
    lastImport: getLastRun()?.finishedAt || null,
    lastTrackingSync: getLastTrackingRun()?.finishedAt || null
  });
});


app.post('/webhooks/printful', async (req, res) => {
  try {
    const signatureCheck = verifyPrintfulWebhookSignature(req);

    if (
      config.printfulWebhookSecret &&
      !signatureCheck.verified
    ) {
      console.warn(
        `Rejected Printful webhook: ${signatureCheck.reason}`
      );
      return res.status(401).json({
        error: 'Invalid Printful webhook signature.'
      });
    }

    const result = await processPrintfulShipmentWebhook(
      req.body,
      config
    );

    console.log(
      `Printful webhook ${req.body?.type || 'unknown'}: ` +
      `${JSON.stringify(result)}`
    );

    return res.status(200).json(result);
  } catch (error) {
    console.error('Printful webhook processing failed:', error);
    return res.status(500).json({
      error: error.message
    });
  }
});

app.get('/api/printful-webhook', requireAdmin, async (_req, res) => {
  try {
    res.json(await getPrintfulWebhookConfig(config));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/setup-printful-webhook', requireAdmin, async (req, res) => {
  try {
    const baseUrl = String(
      req.body?.baseUrl ||
      config.printfulWebhookBaseUrl ||
      ''
    ).trim().replace(/\/+$/, '');

    if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
      return res.status(400).json({
        error:
          'Provide an HTTPS baseUrl, or set PRINTFUL_WEBHOOK_BASE_URL.'
      });
    }

    const webhookUrl = `${baseUrl}/webhooks/printful`;
    const result = await setupPrintfulShipmentWebhook(
      webhookUrl,
      config
    );

    res.json({
      ok: true,
      webhookUrl,
      result,
      nextStep:
        'Copy result.result.secret_key to PRINTFUL_WEBHOOK_SECRET ' +
        'and result.result.public_key to PRINTFUL_WEBHOOK_PUBLIC_KEY, ' +
        'then redeploy.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/synced-product-test', requireAdmin, async (_req, res) => {
  try {
    res.json(await inspectSyncedProductTest(config));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/status', async (_req, res) => {
  const now = Date.now();

  if (statusCache.value && statusCache.expiresAt > now) {
    return res.json({
      ...statusCache.value,
      lastImport: getLastRun(),
      lastTrackingSync: getLastTrackingRun(),
      cached: true
    });
  }

  const result = {
    mode: config.printfulMode,
    stateFile: config.stateFile,
    customFieldValues: config.customFieldValues,
    notifyCustomer: config.shipstationNotifyCustomer,
    notifySalesChannel: config.shipstationNotifySalesChannel,
    printfulStoreId: config.printfulStoreId || null,
    printfulWebhookConfigured: Boolean(config.printfulWebhookSecret),
    useLibraryArtwork: config.printfulUseLibraryArtwork,
    useArtworkMap: config.printfulUseArtworkMap,
    artworkExtension: config.printfulArtworkExtension,
    missingArtworkBehavior: config.printfulMissingArtworkBehavior,
    artworkMapFile: config.artworkMapFile,
    shipstation: null,
    printful: null,
    lastImport: getLastRun(),
    lastTrackingSync: getLastTrackingRun(),
    cached: false
  };

  try {
    result.shipstation = await verifyShipStation(config);
  } catch (error) {
    result.shipstation = { connected: false, error: error.message };
  }

  try {
    result.printful = await verifyPrintful(config);
  } catch (error) {
    result.printful = { connected: false, error: error.message };
  }

  statusCache = {
    value: result,
    expiresAt: now + (60 * 1000)
  };

  res.json(result);
});


app.get('/api/artwork-map', requireAdmin, async (_req, res) => {
  try {
    const map = await loadArtworkMap(config.artworkMapFile);
    res.json({
      file: config.artworkMapFile,
      count: artworkMapEntries(map).length,
      entries: artworkMapEntries(map)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/artwork-map', requireAdmin, async (req, res) => {
  try {
    const { sku, fileId } = req.body || {};
    const map = await loadArtworkMap(config.artworkMapFile);
    const saved = setArtworkFileId(map, sku, fileId, 'manual');
    await saveArtworkMap(config.artworkMapFile, map);
    res.json({ ok: true, sku, ...saved });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


app.post('/api/artwork-map/bulk', requireAdmin, async (req, res) => {
  try {
    const incoming = req.body?.mappings || req.body;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({
        error: 'Expected a JSON object of SKU mappings.'
      });
    }

    const map = await loadArtworkMap(config.artworkMapFile);
    let imported = 0;
    let ignored = 0;

    for (const [sku, value] of Object.entries(incoming)) {
      const fileId = Number(
        value && typeof value === 'object'
          ? value.fileId || value.id
          : value
      );

      if (!sku || !Number.isInteger(fileId) || fileId <= 0) {
        ignored += 1;
        continue;
      }

      setArtworkFileId(map, sku, fileId, 'printful-browser-sync');
      imported += 1;
    }

    await saveArtworkMap(config.artworkMapFile, map);

    res.json({
      ok: true,
      file: config.artworkMapFile,
      imported,
      ignored,
      totalMappings: artworkMapEntries(map).length
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


app.post('/api/reprocess-order', requireAdmin, async (req, res) => {
  try {
    const orderNumber = String(req.body?.orderNumber || req.query.orderNumber || '').trim();
    if (!orderNumber) {
      return res.status(400).json({ error: 'Provide orderNumber, for example AEW178603.' });
    }

    // Intentionally exact and manual-only. This can modify an existing Printful draft.
    res.json(await reprocessOneOrder(orderNumber, config));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/run', requireAdmin, async (_req, res) => {
  try {
    res.json(await runImport(config));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync-tracking', requireAdmin, async (_req, res) => {
  try {
    res.json(await runTrackingSync(config));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/last-run', (_req, res) => {
  res.json(getLastRun() || { message: 'No import has run yet.' });
});

app.get('/api/last-tracking-run', (_req, res) => {
  res.json(getLastTrackingRun() || { message: 'No tracking sync has run yet.' });
});

app.listen(config.port, () => {
  console.log(`ShipStation → Printful bridge v3.13 listening on port ${config.port}`);
  console.log(`Mode: ${config.printfulMode}`);
  console.log(`Visible Printful order number: ShipStation order number`);
  console.log(`Tracking → ShipStation customer notification: ${config.shipstationNotifyCustomer}`);
  console.log(`Tracking → Shopify/sales channel notification: ${config.shipstationNotifySalesChannel}`);
  console.log('Automatic synced products: OLD-SKU | PRODUCT NAME');
  console.log(`Printful synced product cache: ${config.printfulProductCacheMinutes || 10} minute(s), refresh-on-miss enabled`);
  console.log(
    `Synced product pilot: ${config.printfulSyncedProductTestSku || '(disabled)'} ` +
    `-> ${config.printfulSyncedProductTestName || '(not configured)'}`
  );

  if (config.runOnStart) {
    runImport(config)
      .then(result => console.log(
        `Initial import: ${result.groupedOrdersFound} orders, ` +
        `${result.submitted} submitted, ${result.skipped} skipped, ` +
        `${result.failed} failed.`
      ))
      .catch(error => console.error('Initial import failed:', error));

    setTimeout(() => {
      runTrackingSync(config)
        .then(result => console.log(
          `Initial tracking sync: ${result.shipstationOrdersMarked} ShipStation order(s) marked shipped.`
        ))
        .catch(error => console.error('Initial tracking sync failed:', error));
    }, 15000).unref();
  }

  setInterval(() => {
    runImport(config)
      .then(result => console.log(
        `Scheduled import: ${result.groupedOrdersFound} orders, ` +
        `${result.submitted} submitted, ${result.skipped} skipped, ` +
        `${result.failed} failed.`
      ))
      .catch(error => console.error('Scheduled import failed:', error));
  }, config.pollIntervalMinutes * 60 * 1000).unref();

  setInterval(() => {
    runTrackingSync(config).catch(error => console.error('Scheduled tracking sync failed:', error));
  }, config.trackingPollMinutes * 60 * 1000).unref();
});
