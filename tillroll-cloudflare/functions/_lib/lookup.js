// /api/lookup engine: cache first (KV, D1 fallback), then cross-checked
// Brave Search + Gemini Google Search grounding. Contract: Orchestrator 25 Nov 2026.
import { keys, cacheGet, cachePut, normItemId, TTL_SECONDS, NEGATIVE_TTL_SECONDS } from './cache.js';
import { canonicalBrand, officialDomains, isOfficialUrl, isUkRetailerUrl, hostOf, knownBranch } from './brands.js';
import { braveSearch, geminiGrounded } from './sources.js';
import { nowIso } from './http.js';

const str = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[£$€,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const compact = v => normItemId(v).replace(/[-_./]/g, '');
const tokens = s => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(t => t.length > 1));

export function normaliseRequest(body) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Request must be a JSON object.'), { status: 400 });
  const sc = body.storeClues && typeof body.storeClues === 'object' ? body.storeClues : {};
  const req = {
    brandRaw: str(body.brand),
    brand: canonicalBrand(str(body.brand)),
    itemId: str(body.itemId),
    name: str(body.name),
    style: str(body.style),
    price: num(body.price),
    currency: str(body.currency)?.toUpperCase() || null,
    supplier: str(body.supplier),
    storeClues: {
      addressLines: Array.isArray(sc.addressLines) ? sc.addressLines.map(str).filter(Boolean).slice(0, 6) : [],
      postcode: str(sc.postcode), storeNumber: str(sc.storeNumber), phone: str(sc.phone),
    },
    bypassCache: body.bypassCache === true,
  };
  if (!req.itemId && !req.name && !req.style && req.price === null && !req.supplier) throw Object.assign(new Error('Give at least itemId, name, style, price or supplier.'), { status: 400 });
  for (const k of ['itemId', 'name', 'style', 'brand']) if (req[k] && req[k].length > 200) throw Object.assign(new Error(`${k} is too long.`), { status: 400 });
  return req;
}

export function matchedFields(req, c) {
  const out = [];
  if (req.itemId && c.itemId && compact(req.itemId) === compact(c.itemId)) out.push('itemId');
  if (req.brand && c.brand && canonicalBrand(c.brand) === req.brand) out.push('brand');
  if (req.name && c.officialName) {
    const a = tokens(req.name), b = tokens(c.officialName);
    const inter = [...a].filter(t => b.has(t)).length;
    if (a.size && inter / a.size >= 0.5) out.push('name');
  }
  if (req.style && (compact(c.itemId || '') === compact(req.style) || String(c.officialName || '').toLowerCase().includes(req.style.toLowerCase()) || (c.style && compact(c.style) === compact(req.style)))) out.push('style');
  if (req.price !== null && c.price !== null && c.price !== undefined && (!req.currency || !c.currency || req.currency === c.currency)) {
    if (Math.abs(Number(c.price) - req.price) <= Math.max(0.01, req.price * 0.005)) out.push('price');
  }
  return out;
}

function priceFromText(text, currency) {
  const sym = { GBP: '£', EUR: '€', USD: '$' }[currency || 'GBP'] || '£';
  const re = new RegExp(`\\${sym}\\s?([0-9]{1,3}(?:[,][0-9]{3})*(?:\\.[0-9]{2})?|[0-9]+(?:\\.[0-9]{2})?)`);
  const m = String(text || '').match(re);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// Turn raw source output into contract candidates.
export function buildCandidates(req, stage, brave, gemini) {
  const list = [];
  const groundingOfficial = (gemini?.chunks || []).some(ch => isOfficialUrl(ch.url, req.brand, ch.title));
  const braveResults = brave?.results || [];
  for (const g of gemini?.parsed?.candidates || []) {
    if (!g || typeof g !== 'object') continue;
    const urls = (Array.isArray(g.sourceUrls) ? g.sourceUrls : []).filter(u => /^https?:\/\//.test(u)).slice(0, 6);
    const brand = canonicalBrand(str(g.brand)) || req.brand;
    const officialUrl = urls.some(u => isOfficialUrl(u, brand));
    const braveOfficialHit = braveResults.some(r => isOfficialUrl(r.url, brand) && (g.itemId && compact(r.url + ' ' + r.title + ' ' + r.description).includes(compact(g.itemId))));
    list.push({
      brand, officialName: str(g.officialName), itemId: str(g.itemId), price: num(g.price), currency: str(g.currency)?.toUpperCase() || req.currency,
      weightGrams: num(g.weightGrams), sourceUrls: urls, onOfficialSite: Boolean((officialUrl && groundingOfficial) || braveOfficialHit), _sources: new Set(['gemini-grounding']),
    });
  }
  // Brave results on official domains that print the itemId corroborate or add candidates.
  if (stage === 'id' && req.itemId) {
    for (const r of braveResults) {
      const hay = compact(`${r.url} ${r.title} ${r.description} ${r.extra}`);
      if (!hay.includes(compact(req.itemId))) continue;
      const official = isOfficialUrl(r.url, req.brand);
      const existing = list.find(c => c.itemId && compact(c.itemId) === compact(req.itemId));
      if (existing) { existing._sources.add('brave'); if (!existing.sourceUrls.includes(r.url)) existing.sourceUrls.push(r.url); if (official) existing.onOfficialSite = true; continue; }
      if (!official && req.brand && officialDomains(req.brand).length) continue; // retailers only corroborate
      list.push({ brand: req.brand, officialName: str(r.title?.split(/\s[|–-]\s/)[0]), itemId: req.itemId, price: priceFromText(`${r.description} ${r.extra}`, req.currency), currency: req.currency,
        weightGrams: null, sourceUrls: [r.url], onOfficialSite: official || (!req.brand && isUkRetailerUrl(r.url)), _sources: new Set(['brave']) });
    }
  } else {
    for (const c of list) {
      if (braveResults.some(r => c.officialName && tokens(r.title).size && [...tokens(c.officialName)].filter(t => tokens(r.title).has(t)).length >= 2)) c._sources.add('brave');
    }
  }
  const out = [];
  for (const c of list) {
    if (req.brand && officialDomains(req.brand).length && !c.onOfficialSite) continue; // official-brand confirmation rule
    const mf = matchedFields(req, c);
    let matchType;
    if (stage === 'price-fallback') matchType = 'price-fallback';
    else if (mf.includes('itemId')) matchType = 'id';
    else matchType = 'multi-field';
    if (stage === 'id' && matchType !== 'id') continue;
    if (stage === 'multi-field' && mf.filter(f => f !== 'brand').length < 1) continue;
    if (stage === 'price-fallback' && (c.price === null || (req.currency && c.currency && c.currency !== req.currency))) continue;
    const agree = c._sources.size > 1;
    let conf = matchType === 'id' ? 0.6 : matchType === 'multi-field' ? 0.35 : 0.25;
    conf += 0.07 * mf.filter(f => f !== 'itemId').length + (agree ? 0.1 : 0) + (c.onOfficialSite ? 0.05 : 0) + (matchType === 'price-fallback' && c.weightGrams !== null ? 0.05 : 0);
    const cap = matchType === 'id' ? 0.98 : matchType === 'multi-field' ? 0.85 : 0.6;
    out.push({ brand: c.brand, officialName: c.officialName, itemId: c.itemId, price: c.price, currency: c.currency, weightGrams: c.weightGrams,
      sourceUrls: [...new Set(c.sourceUrls)], onOfficialSite: c.onOfficialSite, matchedFields: mf, confidence: Math.round(Math.min(conf, cap) * 100) / 100, matchType });
  }
  if (stage === 'price-fallback') {
    out.sort((a, b) => Math.abs(a.price - req.price) - Math.abs(b.price - req.price) || (a.weightGrams ?? Infinity) - (b.weightGrams ?? Infinity));
  } else {
    out.sort((a, b) => b.matchedFields.length - a.matchedFields.length || b.confidence - a.confidence);
  }
  return out.slice(0, 8);
}

function braveQuery(req, stage) {
  const site = officialDomains(req.brand)[0];
  const scope = site ? ` site:${site}` : ' UK';
  if (stage === 'id') return `"${req.itemId}" ${req.brand || ''}${scope}`.trim();
  if (stage === 'multi-field') return `${req.brand || ''} ${req.name || ''} ${req.style || ''}${scope}`.replace(/\s+/g, ' ').trim();
  return `${req.brand || ''} ${req.name || ''} ${req.currency === 'GBP' ? '£' : ''}${req.price}${scope}`.replace(/\s+/g, ' ').trim();
}

async function runStage(env, req, stage, key, deps, trail) {
  if (!req.bypassCache) {
    const hit = await cacheGet(env, key);
    if (hit) { trail.push({ stage, key, cache: true }); return { ...hit, cacheHit: true }; }
  }
  const [brave, gemini] = await Promise.all([
    braveSearch(env, braveQuery(req, stage), deps),
    geminiGrounded(env, req, stage, deps),
  ]);
  const sourcesQueried = [];
  if (brave.results) sourcesQueried.push('brave');
  if (gemini.parsed !== undefined) sourcesQueried.push('gemini-grounding');
  const problems = [brave, gemini].map(s => s.paused || s.error || s.skipped).filter(Boolean);
  const paused = [brave.paused, gemini.paused].filter(Boolean);
  if (!sourcesQueried.length) { trail.push({ stage, key, cache: false, problems }); return { cacheHit: false, sourcesQueried, candidates: [], unavailable: problems, paused }; }
  const candidates = buildCandidates(req, stage, brave, gemini);
  const value = { sourcesQueried, candidates, storedAt: nowIso() };
  // Only cache complete answers (both sources answered, or one answered with results).
  if (candidates.length || sourcesQueried.length === 2) await cachePut(env, key, value, candidates.length ? TTL_SECONDS : NEGATIVE_TTL_SECONDS);
  trail.push({ stage, key, cache: false, problems });
  return { ...value, cacheHit: false, unavailable: problems, paused };
}

async function resolveBranch(env, req, deps) {
  if (!req.supplier) return null;
  const sc = req.storeClues;
  const clue = sc.postcode || sc.addressLines[0] || sc.storeNumber;
  if (!clue) return null;
  const key = keys.branch(req.supplier, clue);
  if (!req.bypassCache) { const hit = await cacheGet(env, key); if (hit) return { ...hit, cacheKey: key, cacheHit: true }; }
  const known = knownBranch(req.supplier, sc.postcode);
  if (known) { const v = { supplier: req.supplier, officialStoreName: known, sourceUrls: [], source: 'known-branch-table' }; await cachePut(env, key, v); return { ...v, cacheKey: key, cacheHit: false }; }
  const g = await geminiGrounded(env, req, 'branch', deps);
  if (!g.parsed?.branch?.officialStoreName) return { supplier: req.supplier, officialStoreName: null, sourceUrls: [], cacheKey: key, cacheHit: false, unavailable: g.paused || g.error || g.skipped || 'No official branch found.' };
  const v = { supplier: req.supplier, officialStoreName: str(g.parsed.branch.officialStoreName), sourceUrls: (g.parsed.branch.sourceUrls || []).slice(0, 4), source: 'gemini-grounding' };
  await cachePut(env, key, v);
  return { ...v, cacheKey: key, cacheHit: false };
}

export async function lookup(env, body, deps = {}) {
  const req = normaliseRequest(body);
  const trail = [];
  const stages = [];
  if (req.itemId && req.brand !== undefined) stages.push(['id', keys.item(req.brand || '', req.itemId)]);
  if ((req.name || req.style) && req.brand) stages.push(['multi-field', keys.mf(req.brand, req.name || '', req.style || '')]);
  let result = { cacheHit: false, cacheKey: null, sourcesQueried: [], candidates: [] };
  let idMatched = false, idResult = null, unavailable = [], paused = [];
  for (const [stage, key] of stages) {
    const r = await runStage(env, req, stage, key, deps, trail);
    unavailable.push(...(r.unavailable || [])); paused.push(...(r.paused || []));
    result = { cacheHit: r.cacheHit, cacheKey: key, sourcesQueried: r.sourcesQueried, candidates: r.candidates };
    if (stage === 'id') {
      idResult = r;
      if (r.candidates.length) { idMatched = true; break; }
      // sources down / paused / skipped: do not fall through and burn quota
      if (!r.cacheHit && !r.sourcesQueried.length) break;
    }
    if (r.candidates.length) break;
  }
  // Clarification (Orchestrator, 25 Nov): price fallback runs ONLY after an item-ID
  // lookup actually came back with no match — never when that lookup was unavailable or paused.
  // A confirmed no-match is a cache hit (empty id results are only cached when both sources answered)
  // or a live answer from both sources with no pause, error or skip.
  const idConfirmedNoMatch = Boolean(
    req.itemId && !idMatched && idResult && !idResult.candidates.length &&
    (idResult.cacheHit || ((idResult.sourcesQueried || []).length === 2 && !(idResult.paused || []).length && !(idResult.unavailable || []).length))
  );
  if (idConfirmedNoMatch && !result.candidates.length && req.price !== null && req.brand) {
    const key = keys.pf(req.brand, req.currency, req.price);
    const r = await runStage(env, req, 'price-fallback', key, deps, trail);
    unavailable.push(...(r.unavailable || [])); paused.push(...(r.paused || []));
    result = { cacheHit: r.cacheHit, cacheKey: key, sourcesQueried: r.sourcesQueried, candidates: r.candidates };
  }
  const branch = await resolveBranch(env, req, deps);
  const out = { ...result, flag: '#FDE68A', printedItemId: req.itemId, canonicalBrand: req.brand };
  if (branch) out.branch = branch;
  const live = trail.filter(t => !t.cache);
  if (live.length && live.every(t => (t.problems || []).length >= 2)) {
    out.paused = paused.length > 0;
    out.unavailableReason = [...new Set(unavailable)].join(' ');
  }
  if (paused.length) out.quotaGuard = [...new Set(paused)];
  if (env?.DB) {
    try {
      await env.DB.prepare('INSERT INTO lookup_audit (created_at, cache_key, cache_hit, sources_queried, request_json, candidate_count, top_match_type, paused_reason) VALUES (?,?,?,?,?,?,?,?)')
        .bind(nowIso(), out.cacheKey, out.cacheHit ? 1 : 0, JSON.stringify(out.sourcesQueried), JSON.stringify({ ...req, storeClues: undefined }), out.candidates.length, out.candidates[0]?.matchType || null, out.unavailableReason || null).run();
    } catch { /* audit is best effort */ }
  }
  return out;
}

export async function invalidate(env, body) {
  const brand = canonicalBrand(str(body?.brand)) || '';
  const ids = [str(body?.itemId), str(body?.previousItemId)].filter(Boolean);
  if (!ids.length) throw Object.assign(new Error('Give itemId and/or previousItemId.'), { status: 400 });
  const { cacheDelete } = await import('./cache.js');
  const removed = [];
  for (const id of ids) { const k = keys.item(brand, id); removed.push({ key: k, via: await cacheDelete(env, k) }); }
  if (body?.price !== undefined && body?.price !== null && body?.currency) { const k = keys.pf(brand, body.currency, Number(body.price)); removed.push({ key: k, via: await cacheDelete(env, k) }); }
  return { invalidated: removed };
}
