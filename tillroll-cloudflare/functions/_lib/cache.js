import { countKvWrite } from './quota.js';
export const TTL_SECONDS = 30 * 24 * 3600;
export const NEGATIVE_TTL_SECONDS = 3 * 24 * 3600;

const slug = v => String(v ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}&+._-]/gu, '');
export const normItemId = v => String(v ?? '').normalize('NFKC').trim().replace(/\s+/g, '').toUpperCase(); // keeps leading zeros
export const keys = {
  item: (brand, itemId) => `lookup:v2:item:${slug(brand)}:${normItemId(itemId)}`,
  mf: (brand, name, style) => `lookup:v2:mf:${slug(brand)}:${slug(name)}:${slug(style)}`,
  pf: (brand, currency, price) => `lookup:v2:pf:${slug(brand)}:${String(currency || '').trim().toUpperCase()}:${Number(price).toFixed(2)}`,
  branch: (supplier, clue) => `lookup:v2:branch:${slug(supplier)}:${slug(clue)}`,
};
const TOMBSTONE = '{"__tombstone":true}';
export async function cacheGet(env, key) {
  if (env?.DB) {
    const row = await env.DB.prepare('SELECT value_json, expires_at FROM lookup_cache WHERE cache_key=?').bind(key).first();
    if (row && Number(row.expires_at) > Date.now()) {
      if (row.value_json === TOMBSTONE) return null; // invalidated while KV deletes were capped
      return JSON.parse(row.value_json);
    }
  }
  if (env?.LOOKUP_CACHE) {
    const v = await env.LOOKUP_CACHE.get(key, 'json');
    if (v) return v;
  }
  return null;
}
async function d1Put(env, key, body, ttl) {
  await env.DB.prepare('INSERT INTO lookup_cache (cache_key, value_json, expires_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json, expires_at=excluded.expires_at')
    .bind(key, body, Date.now() + ttl * 1000).run();
}
// Returns where it was stored: 'kv' | 'd1' | 'none'.
export async function cachePut(env, key, value, ttl = TTL_SECONDS) {
  const body = JSON.stringify(value);
  if (env?.LOOKUP_CACHE && (await countKvWrite(env))) {
    await env.LOOKUP_CACHE.put(key, body, { expirationTtl: ttl });
    if (env?.DB) await env.DB.prepare('DELETE FROM lookup_cache WHERE cache_key=?').bind(key).run();
    return 'kv';
  }
  if (env?.DB) { await d1Put(env, key, body, ttl); return 'd1'; }
  return 'none';
}
export async function cacheDelete(env, key) {
  // KV deletes count against the same 1,000/day write cap; when capped, a D1 tombstone hides the KV value.
  if (env?.LOOKUP_CACHE && (await countKvWrite(env))) {
    await env.LOOKUP_CACHE.delete(key);
    if (env?.DB) await env.DB.prepare('DELETE FROM lookup_cache WHERE cache_key=?').bind(key).run();
    return 'kv';
  }
  if (env?.DB) { await d1Put(env, key, TOMBSTONE, TTL_SECONDS); return 'd1-tombstone'; }
  return 'none';
}
