// /api/lookup engine: cache first (KV, D1 fallback), then cross-checked
// Brave Search + Gemini Google Search grounding. Contract: Orchestrator 25 Nov 2026.
import { keys, cacheGet, cachePut, normItemId, TTL_SECONDS, NEGATIVE_TTL_SECONDS } from './cache.js';
import { canonicalBrand, officialDomains, isOfficialUrl, isUkRetailerUrl, hostOf, knownBranch, CHANEL_FALLBACK_NOTE, isChanelBrand } from './brands.js';
import { braveSearch, geminiGrounded } from './sources.js';
import { CHANEL_FALLBACK_SCOPE, shouldRetryChanelFallback, sourceBlockedOrFailed, stripNonGbpMirrorPrice, chanelSourceNote } from './chanel.js';
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

// Final tolerance, approved 25 Nov 2026 18:12: max(2% of the receipt price, £5).
export function priceTolerance(price) {
  const n = Math.abs(Number(price));
  if (!Number.isFinite(n)) return 5;
  return Math.max(n * 0.02, 5);
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
    if (Math.abs(Number(c.price) - req.price) <= priceTolerance(req.price)) out.push('price');
  }
  return out;
}

// Price-fallback ranking (Yingzi approved): closeness band is max(2% of printed price, £5).
// Only used after a confirmed item-ID miss (see lookup()).
export function priceFallbackGapBand(printedPrice) {
  const p = Math.abs(Number(printedPrice));
  if (!Number.isFinite(p)) return 5;
  return Math.max(0.02 * p, 5);
}

export function isExactPrice(req, c) {
  if (req?.price === null || req?.price === undefined || c?.price === null || c?.price === undefined) return false;
  if (req.currency && c.currency && req.currency !== c.currency) return false;
  return Math.abs(Number(c.price) - Number(req.price)) < 0.005;
}

// P5: exact item ID + usable official price on the official site (not price-fallback,
// and not an official match whose price is null or a stripped non-GBP mirror price).
export function isExactOfficialIdPriceMatch(req, candidate) {
  if (!candidate?.onOfficialSite) return false;
  if (candidate.matchType === 'price-fallback') return false;
  if (candidate.nonGbpMirrorPrice) return false;
  if (!req?.itemId || !candidate.itemId || compact(req.itemId) !== compact(candidate.itemId)) return false;
  return isExactPrice(req, candidate);
}

// A fallback candidate "GBP-confirms" a price only when it carries a usable GBP amount.
export function isGbpConfirmedPrice(candidate, req) {
  if (!candidate || candidate.nonGbpMirrorPrice) return false;
  if (candidate.price === null || candidate.price === undefined) return false;
  if (!Number.isFinite(Number(candidate.price))) return false;
  const cur = candidate.currency || null;
  if (cur && cur !== 'GBP') return false;
  if (req?.currency && req.currency !== 'GBP' && cur && cur !== req.currency) return false;
  return true;
}

// Fallback comment is exactly CHANEL_FALLBACK_NOTE; the GBP clause is appended
// only when the fallback price is not GBP-confirmed.
export function chanelFallbackComment(candidate, req) {
  if (isGbpConfirmedPrice(candidate, req)) return CHANEL_FALLBACK_NOTE;
  return `${CHANEL_FALLBACK_NOTE}; GBP price cannot be confirmed on the fallback path`;
}

export function priceGap(req, c) {
  if (req?.price === null || req?.price === undefined || c?.price === null || c?.price === undefined) return Infinity;
  return Math.abs(Number(c.price) - Number(req.price));
}

/** Description match: official name shares enough tokens with the printed name. */
export function descriptionMatches(req, c) {
  const mf = Array.isArray(c?.matchedFields) ? c.matchedFields : matchedFields(req, c);
  return mf.includes('name');
}

/** Item-number match: printed style/SKU equals the official item id or style code. */
export function itemNumberMatches(req, c) {
  const style = req?.style;
  if (style && c?.itemId && compact(style) === compact(c.itemId)) return true;
  if (style && c?.style && compact(style) === compact(c.style)) return true;
  return false;
}

// (a) count of {description, item number, exact price} matches. Higher ranks first.
export function comboMatchCount(req, c) {
  return (descriptionMatches(req, c) ? 1 : 0) + (itemNumberMatches(req, c) ? 1 : 0) + (isExactPrice(req, c) ? 1 : 0);
}

// Rank: (a) combo, then (b) exact price, then (c) smallest price gap.
// Among a (a)+(b) group, if a candidate's gap is within the approved
// max(2%, £5) band of the best gap, prefer the lighter published weight.
// Always leave the list intact so the caller can flag Amber with every candidate.
export function rankPriceFallback(req, candidates) {
  const scored = (candidates || []).map((c, i) => ({
    c, i,
    combo: comboMatchCount(req, c),
    exact: isExactPrice(req, c),
    gap: priceGap(req, c),
    weight: c.weightGrams === null || c.weightGrams === undefined ? Infinity : Number(c.weightGrams),
  }));
  scored.sort((a, b) => (b.combo - a.combo) || (Number(b.exact) - Number(a.exact)) || (a.gap - b.gap) || (a.i - b.i));
  const groups = [];
  for (const s of scored) {
    const last = groups[groups.length - 1];
    if (last && last[0].combo === s.combo && last[0].exact === s.exact) last.push(s);
    else groups.push([s]);
  }
  const band = priceFallbackGapBand(req.price);
  const out = [];
  for (const g of groups) {
    const bestGap = Math.min(...g.map(x => x.gap));
    const inBand = x => (x.gap - bestGap) <= band + 1e-9;
    g.sort((a, b) => {
      const aIn = inBand(a), bIn = inBand(b);
      if (aIn && bIn) return (a.weight - b.weight) || (a.gap - b.gap) || (a.i - b.i);
      return (a.gap - b.gap) || (a.weight - b.weight) || (a.i - b.i);
    });
    out.push(...g.map(x => x.c));
  }
  return out;
}

const AMOUNT = '([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)(?![0-9])';

function parseAmount(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let normalised;
  if (lastComma !== -1 && lastDot !== -1) {
    normalised = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    normalised = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot !== -1) {
    normalised = /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s;
  } else {
    normalised = s;
  }
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

function currencyFromText(text, hint) {
  const t = String(text || '');
  if (/£|&pound;|&#163;|(?:^|[^A-Z])GBP(?:[^A-Z]|$)/i.test(t)) return 'GBP';
  if (/€|&euro;|&#8364;|(?:^|[^A-Z])EUR(?:[^A-Z]|$)/i.test(t)) return 'EUR';
  if (/\$|&dollar;|(?:^|[^A-Z])USD(?:[^A-Z]|$)/i.test(t)) return 'USD';
  return hint ? String(hint).toUpperCase() : null;
}

// Parse a displayed official price. Handles £1,234.00, € / $, 1.234,00, and a leading 'From'.
// For free text (snippets, titles) a currency marker, ISO code, or 'From' is required
// so item IDs are not mistaken for prices. Dedicated price fields may be bare amounts.
export function parsePrice(text, hintCurrency, { allowBare = false } = {}) {
  if (text === null || text === undefined || text === '') return null;
  if (typeof text === 'number') {
    return Number.isFinite(text) ? { price: text, currency: hintCurrency ? String(hintCurrency).toUpperCase() : null } : null;
  }
  const t = String(text).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const hint = hintCurrency ? String(hintCurrency).toUpperCase() : null;
  const patterns = [
    new RegExp(`(?:£|€|\\$|GBP|EUR|USD)\\s*${AMOUNT}`, 'i'),
    new RegExp(`${AMOUNT}\\s*(?:£|€|\\$|GBP|EUR|USD)`, 'i'),
    new RegExp(`\\bfrom\\b[:\\s-]*${AMOUNT}`, 'i'),
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const price = parseAmount(m[1]);
    if (price === null) continue;
    return { price, currency: currencyFromText(m[0], hint) };
  }
  if (allowBare) {
    const m = t.match(new RegExp(`^${AMOUNT}$`));
    if (m) {
      const price = parseAmount(m[1]);
      if (price !== null) return { price, currency: hint };
    }
  }
  return null;
}

function priceFromField(value, hintCurrency) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return parsePrice(value, hintCurrency);
  return parsePrice(value, hintCurrency, { allowBare: true });
}

function priceFromSourceText(text, hintCurrency) {
  return parsePrice(text, hintCurrency);
}

function applyParsedPrice(target, parsed, fallbackCurrency) {
  if (!parsed) return;
  target.price = parsed.price;
  target.currency = parsed.currency || target.currency || fallbackCurrency || null;
}

// Turn raw source output into contract candidates.
export function buildCandidates(req, stage, brave, gemini, opts = {}) {
  const list = [];
  const officialOpts = { acceptChanelFallback: opts.chanelFallbackUsed === true };
  const groundingOfficial = (gemini?.chunks || []).some(ch => isOfficialUrl(ch.url, req.brand, ch.title, officialOpts));
  const braveResults = brave?.results || [];
  for (const g of gemini?.parsed?.candidates || []) {
    if (!g || typeof g !== 'object') continue;
    const urls = (Array.isArray(g.sourceUrls) ? g.sourceUrls : []).filter(u => /^https?:\/\//.test(u)).slice(0, 6);
    const brand = canonicalBrand(str(g.brand)) || req.brand;
    const officialUrl = urls.some(u => isOfficialUrl(u, brand, null, officialOpts));
    const braveOfficialHit = braveResults.some(r => isOfficialUrl(r.url, brand, null, officialOpts) && (g.itemId && compact(r.url + ' ' + r.title + ' ' + r.description).includes(compact(g.itemId))));
    const hintCur = str(g.currency)?.toUpperCase() || req.currency;
    const shown = priceFromField(g.price, hintCur) || priceFromSourceText([g.officialName, g.priceText, g.description, ...(Array.isArray(g.sourceSnippets) ? g.sourceSnippets : [])].filter(Boolean).join(' '), hintCur);
    list.push({
      brand, officialName: str(g.officialName), itemId: str(g.itemId), price: shown?.price ?? null, currency: shown?.currency || hintCur,
      weightGrams: num(g.weightGrams), sourceUrls: urls, onOfficialSite: Boolean((officialUrl && groundingOfficial) || braveOfficialHit), _sources: new Set(['gemini-grounding']),
    });
  }
  // Brave results on official domains that print the itemId corroborate or add candidates.
  if (stage === 'id' && req.itemId) {
    for (const r of braveResults) {
      const hay = compact(`${r.url} ${r.title} ${r.description} ${r.extra}`);
      if (!hay.includes(compact(req.itemId))) continue;
      const official = isOfficialUrl(r.url, req.brand, null, officialOpts);
      const existing = list.find(c => c.itemId && compact(c.itemId) === compact(req.itemId));
      const snippetPrice = priceFromSourceText(`${r.title || ''} ${r.description || ''} ${r.extra || ''}`, req.currency);
      if (existing) {
        existing._sources.add('brave');
        if (!existing.sourceUrls.includes(r.url)) existing.sourceUrls.push(r.url);
        if (official) existing.onOfficialSite = true;
        if (existing.price === null || existing.price === undefined) applyParsedPrice(existing, snippetPrice, req.currency);
        continue;
      }
      if (!official && req.brand && officialDomains(req.brand).length) continue; // retailers only corroborate
      list.push({ brand: req.brand, officialName: str(r.title?.split(/\s[|–-]\s/)[0]), itemId: req.itemId, price: snippetPrice?.price ?? null, currency: snippetPrice?.currency || req.currency,
        weightGrams: null, sourceUrls: [r.url], onOfficialSite: official || (!req.brand && isUkRetailerUrl(r.url)), _sources: new Set(['brave']) });
    }
  } else {
    for (const c of list) {
      if (braveResults.some(r => c.officialName && tokens(r.title).size && [...tokens(c.officialName)].filter(t => tokens(r.title).has(t)).length >= 2)) c._sources.add('brave');
    }
  }
  for (let i = 0; i < list.length; i++) list[i] = stripNonGbpMirrorPrice(list[i], opts);
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
      sourceUrls: [...new Set(c.sourceUrls)], onOfficialSite: c.onOfficialSite, matchedFields: mf, confidence: Math.round(Math.min(conf, cap) * 100) / 100, matchType,
      ...(c.nonGbpMirrorPrice ? { nonGbpMirrorPrice: true, publishedPrice: c.publishedPrice, publishedCurrency: c.publishedCurrency } : {}) });
  }
  const finished = out.map(c => {
    const stripped = stripNonGbpMirrorPrice(c, opts);
    const note = chanelSourceNote(stripped, opts);
    return note ? { ...stripped, sourceNote: note } : stripped;
  });
  if (stage === 'price-fallback') {
    // stripNonGbpMirrorPrice has already nulled unusable mirror prices, so they drop out.
    return rankPriceFallback(req, finished).slice(0, 8);
  }
  finished.sort((a, b) => b.matchedFields.length - a.matchedFields.length || b.confidence - a.confidence);
  return finished.slice(0, 8);
}

function braveQuery(req, stage, { chanelFallback = false } = {}) {
  const site = officialDomains(req.brand)[0];
  const scope = (chanelFallback && isChanelBrand(req.brand))
    ? CHANEL_FALLBACK_SCOPE
    : (site ? ` site:${site}` : ' UK');
  if (stage === 'id') return `"${req.itemId}" ${req.brand || ''}${scope}`.trim();
  if (stage === 'multi-field') return `${req.brand || ''} ${req.name || ''} ${req.style || ''}${scope}`.replace(/\s+/g, ' ').trim();
  return `${req.brand || ''} ${req.name || ''} ${req.currency === 'GBP' ? '£' : ''}${req.price}${scope}`.replace(/\s+/g, ' ').trim();
}

async function runStage(env, req, stage, key, deps, trail) {
  if (!req.bypassCache) {
    const hit = await cacheGet(env, key);
    if (hit) { trail.push({ stage, key, cache: true }); return { ...hit, cacheHit: true }; }
  }
  let [brave, gemini] = await Promise.all([
    braveSearch(env, braveQuery(req, stage), deps),
    geminiGrounded(env, req, stage, deps),
  ]);
  let chanelFallbackUsed = false;
  if (shouldRetryChanelFallback(req, brave, gemini)) {
    // Only when chanel.com is blocked or errors — not a genuine no-match.
    const fallbackDeps = { ...deps, chanelFallback: true };
    const retryBrave = sourceBlockedOrFailed(brave) || !(brave.results || []).length;
    const retryGemini = sourceBlockedOrFailed(gemini) || gemini.parsed === undefined;
    const [b2, g2] = await Promise.all([
      retryBrave ? braveSearch(env, braveQuery(req, stage, { chanelFallback: true }), fallbackDeps) : Promise.resolve(brave),
      retryGemini ? geminiGrounded(env, req, stage, fallbackDeps) : Promise.resolve(gemini),
    ]);
    if (retryBrave) brave = b2;
    if (retryGemini) gemini = g2;
    chanelFallbackUsed = true;
  }
  // sourcesQueried lists every source that was actually called (quota reserved),
  // including a later HTTP/parse error, so it stays consistent with the counters.
  const sourcesQueried = [];
  if (!brave.skipped && !brave.paused) sourcesQueried.push('brave');
  if (!gemini.skipped && !gemini.paused) sourcesQueried.push('gemini-grounding');
  const problems = [brave, gemini].map(s => s.paused || s.error || s.skipped).filter(Boolean);
  const paused = [brave.paused, gemini.paused].filter(Boolean);
  const braveAnswered = Array.isArray(brave.results);
  const geminiAnswered = gemini.parsed !== undefined;
  if (!sourcesQueried.length) { trail.push({ stage, key, cache: false, problems }); return { cacheHit: false, sourcesQueried, candidates: [], unavailable: problems, paused }; }
  const candidates = buildCandidates(req, stage, brave, gemini, { chanelFallbackUsed });
  const sourceNote = candidates[0]?.sourceNote || (chanelFallbackUsed && candidates.length ? CHANEL_FALLBACK_NOTE : null);
  const value = { sourcesQueried, candidates, storedAt: nowIso(), ...(sourceNote ? { sourceNote } : {}) };
  // Only cache complete answers (both sources answered, or one answered with results).
  // "Answered" is not the same as "called": an error after reserve is called but not answered.
  if (candidates.length || (braveAnswered && geminiAnswered)) await cachePut(env, key, value, candidates.length ? TTL_SECONDS : NEGATIVE_TTL_SECONDS);
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


const display = v => (v === undefined || v === null || String(v).trim() === '') ? null : (typeof v === 'number' ? v : String(v).trim());
const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
export function officialMismatches(req, candidate) {
  if (!candidate) return [];
  const out = [];
  const receiptBrand = display(req.brandRaw) || display(req.brand);
  const officialBrand = display(candidate.brand);
  // Only emit a field when the receipt printed a value; never receiptValue: null.
  if (officialBrand && receiptBrand && !sameText(receiptBrand, officialBrand)) {
    out.push({ field: 'brand', receiptValue: receiptBrand, officialValue: officialBrand });
  }
  const receiptName = display(req.name);
  const officialName = display(candidate.officialName);
  if (officialName && receiptName && !sameText(receiptName, officialName)) {
    out.push({ field: 'name', receiptValue: receiptName, officialValue: officialName });
  }
  const receiptId = display(req.itemId);
  const officialId = display(candidate.itemId);
  if (officialId && receiptId && compact(receiptId) !== compact(officialId)) {
    out.push({ field: 'itemId', receiptValue: receiptId, officialValue: officialId });
  }
  const receiptPrice = req.price, officialPrice = candidate.price;
  const officialPriceMissing = candidate.onOfficialSite && (officialPrice === null || officialPrice === undefined);
  if (officialPriceMissing) {
    const m = { field: 'price', officialValue: null, reason: 'official price unavailable' };
    if (receiptPrice !== null && receiptPrice !== undefined) m.receiptValue = receiptPrice;
    out.push(m);
  } else if (officialPrice !== null && officialPrice !== undefined && receiptPrice !== null && receiptPrice !== undefined) {
    const sameCurrency = !req.currency || !candidate.currency || req.currency === candidate.currency;
    if (!sameCurrency || Math.abs(Number(officialPrice) - Number(receiptPrice)) > 0.005) {
      out.push({ field: 'price', receiptValue: receiptPrice, officialValue: officialPrice });
    }
  }
  return out;
}

/** True when the top two price-fallback candidates cannot be separated by (a)(b)(c) or weight. */
export function priceFallbackIsTie(req, candidates) {
  if (!candidates || candidates.length < 2) return false;
  const a = candidates[0], b = candidates[1];
  return comboMatchCount(req, a) === comboMatchCount(req, b)
    && isExactPrice(req, a) === isExactPrice(req, b)
    && Math.abs(priceGap(req, a) - priceGap(req, b)) < 0.005
    && (a.weightGrams === null || a.weightGrams === undefined)
    && (b.weightGrams === null || b.weightGrams === undefined);
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
  // sourcesQueried lists calls (quota reserved), so a post-reserve error still appears there;
  // unavailable/paused are what confirm both sources actually answered.
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
  const candidates = (result.candidates || []).map(c => {
    const mismatches = officialMismatches(req, c);
    if (c.sourceNote) mismatches.push({ field: 'source', reason: c.sourceNote });
    return { ...c, mismatches };
  });
  const mismatches = candidates[0]?.mismatches || [];
  const out = { ...result, candidates, mismatches, flag: null, printedItemId: req.itemId, canonicalBrand: req.brand };
  if (candidates[0]?.sourceNote) out.sourceNote = candidates[0].sourceNote;
  else if (result.sourceNote) out.sourceNote = result.sourceNote;
  if (branch) out.branch = branch;
  // Any source pause (quota guard etc.) is reported, even when the other source or another stage still answered.
  if (paused.length) {
    out.paused = true;
    out.unavailableReason = [...new Set(unavailable.filter(Boolean))].join(' ') || [...new Set(paused)].join(' ');
    out.quotaGuard = [...new Set(paused)];
  } else if (unavailable.length && !candidates.length) {
    out.unavailableReason = [...new Set(unavailable.filter(Boolean))].join(' ');
  }
  const itemAttempted = Boolean(req.itemId || req.name || req.style || req.price !== null);
  const top = out.candidates[0];
  const priceFallback = top?.matchType === 'price-fallback';
  const exactOfficial = isExactOfficialIdPriceMatch(req, top);
  const chanelFallback = Boolean(
    out.sourceNote === CHANEL_FALLBACK_NOTE
    || (typeof out.sourceNote === 'string' && out.sourceNote.startsWith(CHANEL_FALLBACK_NOTE))
    || top?.sourceNote === CHANEL_FALLBACK_NOTE
    || (typeof top?.sourceNote === 'string' && top.sourceNote.startsWith(CHANEL_FALLBACK_NOTE))
  );
  const priceUnavailable = (out.mismatches || []).find(m => m.reason === 'official price unavailable');
  if (priceUnavailable) out.flagReason = 'official price unavailable';
  // P6: any fallback-path result stays Amber. The comment is exactly
  // CHANEL_FALLBACK_NOTE, with the GBP clause appended only when the price
  // is not GBP-confirmed. P5 (flag null) applies only to a primary chanel.com hit.
  if (chanelFallback) {
    const comment = chanelFallbackComment(top, req);
    out.sourceNote = comment;
    if (top) top.sourceNote = comment;
    for (const c of out.candidates || []) {
      if (c.sourceNote === CHANEL_FALLBACK_NOTE || (typeof c.sourceNote === 'string' && c.sourceNote.startsWith(CHANEL_FALLBACK_NOTE))) {
        c.sourceNote = comment;
      }
      for (const m of c.mismatches || []) if (m.field === 'source') m.reason = comment;
    }
    for (const m of out.mismatches || []) if (m.field === 'source') m.reason = comment;
    if (!out.flagReason) out.flagReason = comment;
  }
  const flagMismatches = (out.mismatches || []).filter(m => {
    if (m.field === 'source') return false;
    if (exactOfficial && !chanelFallback && (m.field === 'name' || m.field === 'brand')) return false;
    return true;
  });
  if (chanelFallback) {
    out.flag = '#FDE68A';
  } else if (exactOfficial && !priceUnavailable && !out.paused && !out.quotaGuard?.length) {
    out.flag = null;
  } else if (priceFallback || flagMismatches.length || (itemAttempted && !out.candidates.length) || out.paused || out.unavailableReason || out.quotaGuard?.length || top?.matchType === 'multi-field') {
    out.flag = '#FDE68A';
  }
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
  const price = body?.price !== undefined && body?.price !== null ? num(body.price) : null;
  const currency = str(body?.currency)?.toUpperCase() || null;
  const name = str(body?.name);
  const style = str(body?.style);
  const supplier = str(body?.supplier);
  const sc = body?.storeClues && typeof body.storeClues === 'object' ? body.storeClues : {};
  const clue = str(sc.postcode) || str(body?.postcode) || (Array.isArray(sc.addressLines) ? str(sc.addressLines[0]) : null) || str(sc.storeNumber) || str(body?.clue);
  if (!ids.length && price === null && !name && !style && !supplier) {
    throw Object.assign(new Error('Give itemId, previousItemId, price, name, style or supplier.'), { status: 400 });
  }
  const { cacheDelete } = await import('./cache.js');
  const removed = [];
  for (const id of ids) { const k = keys.item(brand, id); removed.push({ key: k, via: await cacheDelete(env, k) }); }
  if (price !== null && currency) { const k = keys.pf(brand, currency, price); removed.push({ key: k, via: await cacheDelete(env, k) }); }
  if (name || style) { const k = keys.mf(brand, name || '', style || ''); removed.push({ key: k, via: await cacheDelete(env, k) }); }
  if (supplier) { const k = keys.branch(supplier, clue || ''); removed.push({ key: k, via: await cacheDelete(env, k) }); }
  return { invalidated: removed };
}
