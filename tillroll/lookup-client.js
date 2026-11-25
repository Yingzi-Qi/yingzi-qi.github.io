// Browser client for POST /api/lookup. Brave and Gemini are never called from here.
// The service caches a match for 30 days and a no-match for 3 days, keyed by
// normalised brand + item id. Rounded price is part of that key only for a
// price-fallback result. This client mirrors that so a repeat does not fight it.

import { canonicalBrand, normaliseItemId } from './brand-aliases.js';
import { roundMoney } from './lookup-policy.js';
import { parseMismatches } from './lookup-match.js';

const DAY = 24 * 60 * 60 * 1000;
const MATCH_TTL = 30 * DAY;
const MISS_TTL = 3 * DAY;
const BLOCKED_HOST = /(^|\.)(?:brave\.com|googleapis\.com)$/i;

const text = value => {
  if (value == null) return '';
  const trimmed = String(value).trim();
  return trimmed;
};

function weight(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function asBool(value) {
  return value === true || value === 'true';
}

export function normaliseCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const known = new Set(['brand', 'officialName', 'itemId', 'style', 'price', 'currency', 'weightGrams', 'sourceUrls', 'onOfficialSite', 'matchedFields', 'confidence', 'matchType', 'mismatches']);
  const extra = {};
  for (const [key, value] of Object.entries(raw)) if (!known.has(key)) extra[key] = value;
  return {
    brand: text(raw.brand),
    officialName: text(raw.officialName),
    itemId: raw.itemId == null ? '' : String(raw.itemId),
    style: text(raw.style),
    price: roundMoney(raw.price),
    currency: text(raw.currency).toUpperCase(),
    weightGrams: weight(raw.weightGrams),
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls.map(String) : [],
    onOfficialSite: raw.onOfficialSite === true,
    matchedFields: Array.isArray(raw.matchedFields) ? raw.matchedFields.map(String) : [],
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null,
    matchType: text(raw.matchType),
    mismatches: parseMismatches(raw.mismatches),
    extra,
  };
}

function normaliseBranch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    supplier: text(raw.supplier),
    officialStoreName: raw.officialStoreName == null ? null : text(raw.officialStoreName) || null,
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls.map(String) : [],
    source: text(raw.source),
    cacheKey: raw.cacheKey == null ? null : String(raw.cacheKey),
    cacheHit: asBool(raw.cacheHit),
    unavailable: raw.unavailable ? text(raw.unavailable) || true : undefined,
    extra: raw,
  };
}

export function parseLookupResponse(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const known = new Set(['cacheHit', 'cacheKey', 'sourcesQueried', 'candidates', 'flag', 'printedItemId', 'canonicalBrand', 'branch', 'paused', 'unavailableReason', 'quotaGuard', 'mismatches']);
  const extra = {};
  for (const [key, value] of Object.entries(body)) if (!known.has(key)) extra[key] = value;
  const quotaGuard = Array.isArray(body.quotaGuard) ? body.quotaGuard.map(String)
    : body.quotaGuard ? [String(body.quotaGuard)] : [];
  return {
    cacheHit: asBool(body.cacheHit),
    cacheKey: body.cacheKey == null ? null : String(body.cacheKey),
    sourcesQueried: Array.isArray(body.sourcesQueried) ? body.sourcesQueried.map(entry => typeof entry === 'string' ? entry : text(entry?.name || entry?.url || '')) : [],
    candidates: Array.isArray(body.candidates) ? body.candidates.map(normaliseCandidate).filter(Boolean) : [],
    flag: body.flag == null ? null : body.flag,
    printedItemId: body.printedItemId == null ? null : String(body.printedItemId),
    canonicalBrand: body.canonicalBrand == null ? null : text(body.canonicalBrand) || null,
    branch: normaliseBranch(body.branch),
    paused: asBool(body.paused),
    unavailableReason: text(body.unavailableReason),
    quotaGuard,
    mismatches: parseMismatches(body.mismatches),
    extra,
  };
}

function invalidateStoreClues(request) {
  const given = request?.storeClues && typeof request.storeClues === 'object' ? request.storeClues : {};
  const addressLines = Array.isArray(given.addressLines)
    ? given.addressLines.map(line => String(line ?? '').trim()).filter(Boolean).slice(0, 6)
    : [];
  if (!addressLines.length && request?.addressLine1) addressLines.push(String(request.addressLine1).trim());
  const postcode = String(given.postcode ?? request?.postcode ?? '').trim();
  const storeNumber = String(given.storeNumber ?? request?.storeNumber ?? '').trim();
  if (!postcode && !addressLines.length && !storeNumber) return null;
  const storeClues = { addressLines };
  if (postcode) storeClues.postcode = postcode;
  if (storeNumber) storeClues.storeNumber = storeNumber;
  return storeClues;
}

export function branchClue(storeClues) {
  const clues = storeClues || {};
  return String(clues.postcode || '').trim()
    || (Array.isArray(clues.addressLines) ? String(clues.addressLines[0] || '').trim() : '')
    || String(clues.storeNumber || '').trim();
}

export function slug(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}&+._-]/gu, '');
}

function brandSlug(brand) {
  return slug(canonicalBrand(brand) || brand || '');
}

export const cacheKeys = {
  item: (brand, itemId) => `lookup:v2:item:${brandSlug(brand)}:${normaliseItemId(itemId)}`,
  mf: (brand, name, style) => `lookup:v2:mf:${brandSlug(brand)}:${slug(name)}:${slug(style)}`,
  pf: (brand, currency, price) => `lookup:v2:pf:${brandSlug(brand)}:${String(currency || '').trim().toUpperCase()}:${Number(price).toFixed(2)}`,
  branch: (supplier, clue) => `lookup:v2:branch:${slug(supplier)}:${slug(clue)}`,
};

function cacheKind(parsed) {
  const types = new Set((parsed.candidates || []).map(candidate => candidate.matchType));
  if (!parsed.candidates.length) return 'miss';
  if (types.has('id')) return 'match';
  if (types.has('price-fallback')) return 'price-fallback';
  if (types.has('multi-field')) return 'multi-field';
  return 'match';
}

export function cacheStorageKey(request, kind) {
  const itemId = normaliseItemId(request.itemId);
  if (kind === 'price-fallback') return cacheKeys.pf(request.brand, request.currency, request.price);
  if (kind === 'multi-field') return cacheKeys.mf(request.brand, request.name, request.style);
  if (!itemId && (request.name || request.style)) return cacheKeys.mf(request.brand, request.name, request.style);
  if (!itemId && request.price != null) return cacheKeys.pf(request.brand, request.currency, request.price);
  return cacheKeys.item(request.brand, request.itemId);
}

function requestKey(body) {
  return JSON.stringify(body);
}

function endpointFor(baseUrl, kind) {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!base) return '';
  let url;
  try { url = new URL(base.includes('://') ? base : `https://${base}`); }
  catch { return ''; }
  if (BLOCKED_HOST.test(url.hostname)) return '';
  const root = base.replace(/\/api\/lookup(?:\/invalidate)?$/, '');
  return kind === 'invalidate' ? `${root}/api/lookup/invalidate` : `${root}/api/lookup`;
}

async function readError(response) {
  try { return await response.json(); }
  catch { return {}; }
}

export function createLookupClient({ baseUrl = '', fetchImpl = globalThis.fetch, maxLookupsPerRun = 60, now = () => Date.now(), onLocked = null } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const state = {
    lookupsUsed: 0,
    lookupsDeferred: 0,
    paused: false,
    locked: false,
    reasons: [],
    lockNotified: false,
  };

  function remember(body, parsed) {
    if (parsed.paused || parsed.unavailableReason || parsed.quotaGuard?.length) return;
    const kind = cacheKind(parsed);
    const key = cacheStorageKey(body, kind);
    cache.set(key, { storedAt: now(), ttl: kind === 'miss' ? MISS_TTL : MATCH_TTL, kind, parsed, price: roundMoney(body.price) });
  }

  function recall(body) {
    if (body.bypassCache) return null;
    const keys = [];
    if (normaliseItemId(body.itemId)) keys.push(cacheKeys.item(body.brand, body.itemId));
    if (body.name || body.style) keys.push(cacheKeys.mf(body.brand, body.name, body.style));
    if (body.price != null && body.price !== '') keys.push(cacheKeys.pf(body.brand, body.currency, body.price));
    for (const key of keys) {
      const hit = cache.get(key);
      if (!hit) continue;
      if (now() >= hit.storedAt + hit.ttl) { cache.delete(key); continue; }
      if (hit.kind === 'price-fallback' && roundMoney(hit.price) !== roundMoney(body.price)) continue;
      return hit.parsed;
    }
    return null;
  }

  function forget(request) {
    if (!request) return;
    if (request.itemId) cache.delete(cacheKeys.item(request.brand, request.itemId));
    if (request.previousItemId) cache.delete(cacheKeys.item(request.brand, request.previousItemId));
    cache.delete(cacheKeys.mf(request.brand, request.name, request.style));
    if (request.price != null && request.price !== '') cache.delete(cacheKeys.pf(request.brand, request.currency, request.price));
    const storeClues = invalidateStoreClues(request);
    const clue = branchClue(storeClues);
    if (request.supplier && clue) cache.delete(cacheKeys.branch(request.supplier, clue));
  }

  function halt(code, message) {
    return { ok: false, paused: state.paused, locked: state.locked, deferred: false, error: { code, message }, deduped: false };
  }

  async function send(url, body, { store = false } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, error: { code: 'network', message: String(error?.message || 'Look-up could not be reached.') } };
    }
    if (response.status === 401) {
      const payload = await readError(response);
      state.locked = true;
      const message = payload.error || 'Unlock Tillroll first.';
      if (!state.lockNotified) {
        state.lockNotified = true;
        onLocked?.(payload);
      }
      state.reasons.push(message);
      return { ok: false, locked: true, error: { code: payload.code || 'locked', message } };
    }
    if (response.status === 503 || response.status === 429) {
      const payload = await readError(response);
      state.paused = true;
      const message = payload.error || (response.status === 429 ? 'Look-up quota or rate limit.' : 'Look-up is unavailable.');
      state.reasons.push(message);
      return { ok: false, paused: true, error: { code: String(response.status), message } };
    }
    if (!response.ok) {
      const payload = await readError(response);
      return { ok: false, error: { code: String(response.status), message: payload.error || `Look-up failed (${response.status}).` } };
    }
    try {
      const parsed = parseLookupResponse(await response.json());
      if (parsed.paused || parsed.unavailableReason || parsed.quotaGuard.length) {
        state.paused = true;
        const message = parsed.unavailableReason || parsed.quotaGuard.join(' ') || 'Look-up paused.';
        state.reasons.push(message);
      } else if (store) {
        remember(body, parsed);
      }
      return { ok: true, ...parsed };
    } catch (error) {
      return { ok: false, error: { code: 'invalid', message: String(error?.message || 'Look-up response was not JSON.') } };
    }
  }

  async function lookup(body) {
    const url = endpointFor(baseUrl, 'lookup');
    if (!url) {
      if (baseUrl && BLOCKED_HOST.test(String(baseUrl))) {
        return halt('blocked', 'Search providers are not called from the browser.');
      }
      return { ok: false, skipped: true, error: { code: 'unconfigured', message: 'Look-up base URL is not set.' } };
    }
    if (state.locked) return halt('locked', state.reasons.at(-1) || 'Unlock Tillroll first.');
    if (state.paused) return halt('paused', state.reasons.at(-1) || 'Look-up paused.');
    const cached = recall(body);
    if (cached) return { ok: true, ...cached, fromClientCache: true, deduped: true };
    const key = requestKey(body);
    if (inflight.has(key)) {
      const shared = await inflight.get(key);
      return { ...shared, deduped: true };
    }
    if (state.lookupsUsed >= maxLookupsPerRun) {
      state.lookupsDeferred += 1;
      return { ok: false, deferred: true, error: { code: 'run-cap', message: `Look-up deferred: the run is limited to ${maxLookupsPerRun}.` } };
    }
    state.lookupsUsed += 1;
    const pending = send(url, body, { store: true });
    inflight.set(key, pending);
    try { return await pending; }
    finally { inflight.delete(key); }
  }

  async function invalidate(request) {
    const body = {};
    if (request?.brand) body.brand = String(request.brand);
    if (request?.itemId) body.itemId = String(request.itemId);
    if (request?.previousItemId) body.previousItemId = String(request.previousItemId);
    if (request?.name) body.name = String(request.name);
    if (request?.style) body.style = String(request.style);
    if (request?.supplier) body.supplier = String(request.supplier);
    if (request?.currency) body.currency = String(request.currency);
    if (request?.price != null && request.price !== '') body.price = Number(request.price);
    const storeClues = invalidateStoreClues(request);
    if (storeClues) body.storeClues = storeClues;
    forget(request);
    const url = endpointFor(baseUrl, 'invalidate');
    if (!url) return { ok: false, skipped: true, error: { code: 'unconfigured', message: 'Look-up base URL is not set.' } };
    if (state.locked) return halt('locked', 'Unlock Tillroll first.');
    const result = await send(url, body, { store: false });
    return result.ok ? { ok: true } : { ok: false, error: result.error, locked: result.locked, paused: result.paused };
  }

  function resetRun() {
    state.lookupsUsed = 0;
    state.lookupsDeferred = 0;
    state.paused = false;
    state.locked = false;
    state.reasons = [];
    state.lockNotified = false;
    inflight.clear();
  }

  return {
    lookup,
    invalidate,
    resetRun,
    forget,
    configured: Boolean(endpointFor(baseUrl, 'lookup')),
    endpoint: endpointFor(baseUrl, 'lookup'),
    get lookupsUsed() { return state.lookupsUsed; },
    get lookupsDeferred() { return state.lookupsDeferred; },
    get paused() { return state.paused; },
    get locked() { return state.locked; },
    get pausedReasons() { return [...state.reasons]; },
  };
}
