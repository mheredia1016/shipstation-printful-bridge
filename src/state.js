import fs from 'node:fs/promises';
import path from 'node:path';

let writeQueue = Promise.resolve();

function emptyState() {
  return {
    imported: {},
    tracking: {},
    meta: {}
  };
}

function normalizeState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};

  if (!state.imported || typeof state.imported !== 'object' || Array.isArray(state.imported)) {
    state.imported = {};
  }
  if (!state.tracking || typeof state.tracking !== 'object' || Array.isArray(state.tracking)) {
    state.tracking = {};
  }
  if (!state.meta || typeof state.meta !== 'object' || Array.isArray(state.meta)) {
    state.meta = {};
  }
  if (!state.orders || typeof state.orders !== 'object' || Array.isArray(state.orders)) {
    state.orders = {};
  }

  return state;
}

function findFirstCompleteJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, i + 1);
        try {
          return normalizeState(JSON.parse(candidate));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

async function ensureParent(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

async function backupCorruptedState(file, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt-${stamp}.bak`;
  await fs.writeFile(backup, raw, 'utf8');
  console.error(`[STATE RECOVERY] Preserved corrupted state as ${backup}`);
  return backup;
}

async function atomicWrite(file, state) {
  await ensureParent(file);

  const normalized = normalizeState(state);
  const body = JSON.stringify(normalized, null, 2) + '\n';

  // Validate exactly what will be persisted before touching the live state.
  JSON.parse(body);

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body, 'utf8');

  // Re-read and validate the temp file before the atomic rename.
  const check = await fs.readFile(tmp, 'utf8');
  JSON.parse(check);

  await fs.rename(tmp, file);
}

export async function loadState(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');

    try {
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      console.error(
        `[STATE RECOVERY] State JSON is corrupted: ${error.message}`
      );

      await backupCorruptedState(file, raw);

      // The observed corruption is valid JSON followed by extra JSON/text.
      // Recover the first complete valid object without discarding mappings.
      const recovered = findFirstCompleteJsonObject(raw);

      if (!recovered) {
        throw new Error(
          `State file is corrupted and automatic recovery could not find a ` +
          `complete valid JSON object. A backup was preserved next to ${file}.`
        );
      }

      await atomicWrite(file, recovered);

      console.log(
        `[STATE RECOVERY] Recovered ${file} and rewrote it as valid JSON. ` +
        `Imported mappings: ${Object.keys(recovered.imported || {}).length}; ` +
        `tracking mappings: ${Object.keys(recovered.tracking || {}).length}.`
      );

      return recovered;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveState(file, state) {
  // Serialize all writes within the process. A failed write must not poison
  // later queued writes, so each call chains from a caught queue.
  const task = writeQueue
    .catch(() => {})
    .then(() => atomicWrite(file, state));

  writeQueue = task;
  return task;
}


// v3.30: keep the 30-day reconciliation cursor in its own sidecar file.
// Tracking and import jobs both persist bridge-state.json; a long-running job
// can otherwise save an older in-memory meta object after reconciliation and
// roll the cursor backward. The sidecar is only written by reconciliation.
function reconcileCursorFile(stateFile) {
  return path.join(path.dirname(stateFile), 'reconcile-30day-cursor.json');
}

export async function loadReconcile30DayCursor(stateFile, fallbackPage = 1) {
  const file = reconcileCursorFile(stateFile);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const page = Number(parsed?.page);
    return Number.isFinite(page) && page >= 1 ? Math.floor(page) : Math.max(1, Number(fallbackPage || 1));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`[30-DAY CURSOR] Could not read ${file}: ${error.message}`);
    }
    return Math.max(1, Number(fallbackPage || 1));
  }
}

export async function saveReconcile30DayCursor(stateFile, page, extra = {}) {
  const file = reconcileCursorFile(stateFile);
  await ensureParent(file);
  const safePage = Math.max(1, Math.floor(Number(page || 1)));
  const body = JSON.stringify({ page: safePage, updatedAt: new Date().toISOString(), ...extra }, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body, 'utf8');
  JSON.parse(await fs.readFile(tmp, 'utf8'));
  await fs.rename(tmp, file);
  return safePage;
}
