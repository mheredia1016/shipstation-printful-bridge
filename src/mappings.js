import fs from 'node:fs/promises';
import { parse } from 'csv-parse/sync';

export async function loadMappings(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  const map = new Map();

  for (const row of rows) {
    const active = String(row.active || 'true').toLowerCase() === 'true';
    if (!active || !row.sku) continue;

    if (!row.printful_variant_id || !row.front_art_url) {
      throw new Error(`Mapping for SKU ${row.sku} requires printful_variant_id and front_art_url.`);
    }

    map.set(String(row.sku).trim().toLowerCase(), row);
  }

  return map;
}

export function mapOrderItems(order, mappings) {
  const mapped = [];
  const missing = [];

  for (const item of order.items || []) {
    const key = String(item.sku || '').trim().toLowerCase();
    const mapping = mappings.get(key);

    if (!mapping) {
      missing.push({
        sku: item.sku || '',
        name: item.name || '',
        quantity: item.quantity || 0
      });
      continue;
    }

    mapped.push({ item, mapping });
  }

  return { mapped, missing };
}
