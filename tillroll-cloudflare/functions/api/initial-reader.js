import { json, error, readJson, nowIso, randomId } from '../_lib/http.js';
import { requireAccess } from '../_lib/access.js';
import { normaliseInitialReceipt, matchInitialReceipt } from '../_lib/initial-reader.js';
import { canonicalBrand } from '../_lib/brands.js';
import { lookup } from '../_lib/lookup.js';

function itemQuery(item) {
  const brand = item.brand ? canonicalBrand(item.brand) : null;
  if (item.reference && brand) return {
    sql: 'SELECT brand, item_id, official_name, price_pence, currency, source_url, weight_grams FROM catalogue_items WHERE item_id=? OR brand=? LIMIT 500',
    args: [item.reference, brand],
  };
  if (item.reference) return {
    sql: 'SELECT brand, item_id, official_name, price_pence, currency, source_url, weight_grams FROM catalogue_items WHERE item_id=? LIMIT 500',
    args: [item.reference],
  };
  if (brand) return {
    sql: 'SELECT brand, item_id, official_name, price_pence, currency, source_url, weight_grams FROM catalogue_items WHERE brand=? LIMIT 500',
    args: [brand],
  };
  return {
    sql: 'SELECT brand, item_id, official_name, price_pence, currency, source_url, weight_grams FROM catalogue_items LIMIT 500',
    args: [],
  };
}

async function catalogueFor(env, item) {
  if (!env?.DB) return [];
  const query = itemQuery(item);
  const result = await env.DB.prepare(query.sql).bind(...query.args).all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function discoverCandidates(env, item, enabled) {
  if (!enabled || (!env?.BRAVE_API_KEY && !env?.GEMINI_API_KEY) || (!item.brand && !item.name && !item.reference)) return { candidates: [], attempted: false, error: null };
  try {
    const result = await lookup(env, {
      brand: item.brand,
      itemId: item.reference,
      name: item.name,
      price: item.itemPrice,
      currency: 'GBP',
    });
    const candidates = (Array.isArray(result?.candidates) ? result.candidates : [])
      .filter(candidate => candidate?.onOfficialSite === true)
      .map(candidate => ({
        brand: candidate.brand,
        officialName: candidate.officialName,
        itemId: candidate.itemId,
        price: candidate.price,
        currency: candidate.currency,
        weightGrams: candidate.weightGrams,
        sourceUrl: candidate.sourceUrls?.[0] || null,
      }));
    return { candidates, attempted: true, error: null };
  } catch (cause) {
    return { candidates: [], attempted: true, error: String(cause?.message || cause) };
  }
}

function uniqueCandidates(rows) {
  const seen = new Set();
  return rows.filter(candidate => {
    const key = [candidate.brand, candidate.itemId, candidate.price, candidate.currency || 'GBP'].map(value => String(value || '').toLowerCase()).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function persist(env, reading, matches, reviewFlags, now) {
  if (!env?.DB) return null;
  if (reading.evidence.imageHash) {
    const existing = await env.DB.prepare('SELECT reading_id FROM initial_receipt_readings WHERE image_hash=? LIMIT 1').bind(reading.evidence.imageHash).first();
    if (existing?.reading_id) return { readingId: existing.reading_id, duplicate: true };
  }
  const readingId = randomId('ird_');
  const statements = [env.DB.prepare(`INSERT INTO initial_receipt_readings
    (reading_id, image_hash, receipt_id, reading_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(readingId, reading.evidence.imageHash, reading.receiptId, JSON.stringify(reading), reviewFlags.length || reading.reviewRequired ? 'review' : 'ready', now, now)];
  for (const item of reading.items) {
    statements.push(env.DB.prepare('INSERT INTO initial_receipt_lines (reading_id, line_index, line_json) VALUES (?, ?, ?)')
      .bind(readingId, item.index, JSON.stringify(item)));
  }
  for (const [index, match] of matches.entries()) {
    statements.push(env.DB.prepare('INSERT INTO initial_match_candidates (reading_id, line_index, match_json, created_at) VALUES (?, ?, ?, ?)')
      .bind(readingId, index, JSON.stringify(match), now));
  }
  for (const item of [...reading.flags, ...reviewFlags]) {
    statements.push(env.DB.prepare('INSERT INTO initial_review_events (reading_id, field, reason, severity, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(readingId, item.field, item.reason, item.severity || 'Amber', now));
  }
  await env.DB.batch(statements);
  return { readingId, duplicate: false };
}

export async function onRequestPost({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  let body;
  try { body = await readJson(request, 100_000); } catch (cause) { return error(cause.status || 400, cause.message); }
  const input = body?.reading ?? body?.receipt ?? body;
  const reading = normaliseInitialReceipt(input);
  const duplicateFlags = [];
  if (env?.DB && reading.receiptId) {
    const prior = await env.DB.prepare('SELECT reading_id, image_hash FROM initial_receipt_readings WHERE receipt_id=? LIMIT 1').bind(reading.receiptId).first();
    if (prior && prior.image_hash !== reading.evidence.imageHash) duplicateFlags.push({ field: 'receiptId', code: 'duplicate_receipt_id', severity: 'Amber', reason: 'The receipt ID already belongs to a different image hash.' });
  }
  const configuredDiscovery = body?.discover !== false;
  const localCatalogues = await Promise.all(reading.items.map(item => catalogueFor(env, item)));
  const localMatched = matchInitialReceipt(reading, localCatalogues);
  const discovery = await Promise.all(reading.items.map((item, index) => discoverCandidates(env, item, configuredDiscovery && localMatched.matches[index]?.status !== 'accepted').then(result => ({ index, ...result }))));
  const catalogues = localCatalogues.map((rows, index) => uniqueCandidates([...rows, ...discovery[index].candidates]));
  const matched = matchInitialReceipt(reading, catalogues);
  const discoveryFlags = discovery.filter(result => result.error).map(result => ({
    field: `items[${result.index}].catalogue`,
    code: 'catalogue_discovery',
    severity: 'Amber',
    reason: 'Official catalogue discovery failed. The item remains review-only.',
  }));
  const now = nowIso();
  let readingId = null;
  let duplicate = false;
  let persistenceWarning = null;
  try { const persisted = await persist(env, reading, matched.matches, [...matched.reviewFlags, ...duplicateFlags, ...discoveryFlags], now); readingId = persisted?.readingId || null; duplicate = Boolean(persisted?.duplicate); }
  catch (cause) { persistenceWarning = 'Initial-reader result was produced, but D1 persistence failed. Apply migration 0003_initial_reader.sql and retry.'; }
  return json({
    readingId,
    duplicate,
    reading,
    matches: matched.matches,
    discovery: discovery.map(({ index, attempted, candidates, error: discoveryError }) => ({ index, attempted, candidateCount: candidates.length, error: discoveryError })),
    reviewFlags: [...reading.flags, ...duplicateFlags, ...discoveryFlags, ...matched.reviewFlags],
    reviewRequired: matched.reviewRequired || duplicateFlags.length > 0 || discoveryFlags.length > 0 || Boolean(persistenceWarning),
    persistenceWarning,
  });
}
