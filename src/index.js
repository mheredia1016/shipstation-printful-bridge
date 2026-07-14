import {
  artworkMapEntries,
  loadArtworkMap,
  saveArtworkMap,
  setArtworkFileId
} from './artwork-map.js';
import express from 'express';
import { getConfig } from './config.js';
import { verifyShipStation } from './shipstation.js';
import { verifyPrintful } from './printful.js';
import {
  runImport,
  runTrackingSync,
  getLastRun,
  getLastTrackingRun
} from './runner.js';

const config = getConfig();
const app = express();

let statusCache = {
  expiresAt: 0,
  value: null
};

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

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
    notifyCustomer: config.shipstationNotifyCustomer,
    notifySalesChannel: config.shipstationNotifySalesChannel,
    useLibraryArtwork: config.printfulUseLibraryArtwork,
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
  console.log(`ShipStation → Printful bridge v3.0 listening on port ${config.port}`);
  console.log(`Mode: ${config.printfulMode}`);
  console.log(`Visible Printful order number: ShipStation order number`);
  console.log(`Tracking → ShipStation customer notification: ${config.shipstationNotifyCustomer}`);
  console.log(`Tracking → Shopify/sales channel notification: ${config.shipstationNotifySalesChannel}`);

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
