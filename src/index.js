import express from 'express';
import { getConfig } from './config.js';
import { verifyShipStation } from './shipstation.js';
import { verifyPrintful } from './printful.js';
import { runImport, getLastRun } from './runner.js';

const config = getConfig();
const app = express();

app.use(express.json({ limit: '1mb' }));
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
    lastRun: getLastRun()?.finishedAt || null
  });
});

app.get('/api/status', async (_req, res) => {
  const result = {
    mode: config.printfulMode,
    customFieldValue: config.customFieldValue,
    shipstation: null,
    printful: null,
    lastRun: getLastRun()
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

  res.json(result);
});

app.post('/api/run', requireAdmin, async (req, res) => {
  try {
    const result = await runImport(config, {
      forceOrderId: req.body?.orderId || null
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/last-run', (_req, res) => {
  res.json(getLastRun() || { message: 'No import has run yet.' });
});

app.listen(config.port, () => {
  console.log(`ShipStation → Printful bridge listening on port ${config.port}`);
  console.log(`Mode: ${config.printfulMode}`);
  console.log(`Matching Custom Field 1: ${config.customFieldValue}`);

  if (config.runOnStart) {
    runImport(config)
      .then(result => console.log(`Initial scan complete: ${result.found} matching order(s).`))
      .catch(error => console.error('Initial scan failed:', error));
  }

  setInterval(() => {
    runImport(config)
      .then(result => console.log(`Scheduled scan complete: ${result.found} matching order(s).`))
      .catch(error => console.error('Scheduled scan failed:', error));
  }, config.pollIntervalMinutes * 60 * 1000).unref();
});
