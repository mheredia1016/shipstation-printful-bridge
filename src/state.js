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
