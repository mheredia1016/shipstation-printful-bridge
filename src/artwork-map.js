import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeSku(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.png$/i, '');
}

export async function loadArtworkMap(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveArtworkMap(filePath, map) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(map, null, 2));
  await fs.rename(temp, filePath);
}

export function getArtworkFileId(map, sku) {
  const key = normalizeSku(sku);
  const value = map[key];

  if (value && typeof value === 'object') {
    return Number(value.fileId || value.id || 0) || null;
  }

  return Number(value || 0) || null;
}

export function setArtworkFileId(map, sku, fileId, source = 'manual') {
  const key = normalizeSku(sku);
  if (!key) throw new Error('Artwork SKU is required.');

  const id = Number(fileId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Artwork fileId must be a positive integer.');
  }

  map[key] = {
    fileId: id,
    source,
    updatedAt: new Date().toISOString()
  };

  return map[key];
}

export function artworkMapEntries(map) {
  return Object.entries(map)
    .map(([sku, value]) => ({
      sku,
      fileId: Number(
        value && typeof value === 'object'
          ? value.fileId || value.id
          : value
      ),
      source:
        value && typeof value === 'object'
          ? value.source || 'unknown'
          : 'legacy'
    }))
    .filter(entry => Number.isInteger(entry.fileId) && entry.fileId > 0)
    .sort((a, b) => a.sku.localeCompare(b.sku));
}
