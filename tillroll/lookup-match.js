// Accept an official-site candidate, then compare it with the receipt.
// Price fallback ranks only candidates the service already marked price-fallback,
// and only after the item id matched nothing. It does not run when that id stage
// was paused, errored or skipped. An id match already in a paused response is still used.
// Candidates within max(2% of the printed price, £5) of the best gap are close.
// That band is decided.

import { canonicalBrand, fold, normaliseItemId } from './brand-aliases.js';
import { canonicalDisplayBrand, roundMoney } from './lookup-policy.js';

// Decided close band: max(2% of the printed price, £5).
export const CLOSE_GAP = { percent: 0.02, floor: 5 };

const FIELD_NAMES = {
  brand: '品牌',
  '品牌': '品牌',
  name: '品名',
  officialname: '品名',
  '品名': '品名',
  price: '采购商品原价',
  '采购商品原价': '采购商品原价',
  '采购商品金额': '采购商品金额',
  itemid: '品牌货号',
  '品牌货号': '品牌货号',
  supplier: '供应商',
  '供应商': '供应商',
};

export function flagColour(response) {
  const value = response && typeof response === 'object' ? response.flag : response;
  if (value == null || value === '') return null;
  return value === '#FDE68A' ? '#FDE68A' : null;
}

export function closeGapWidth(printedPrice, closeGap = CLOSE_GAP) {
  const percent = Number(closeGap?.percent ?? CLOSE_GAP.percent);
  const floor = Number(closeGap?.floor ?? CLOSE_GAP.floor);
  return Math.max(Math.abs(Number(printedPrice) || 0) * percent, floor);
}

function tokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 1);
}

function descriptionAgrees(name, candidate) {
  if ((candidate.matchedFields || []).includes('name')) return true;
  const left = new Set(tokens(name));
  const right = new Set(tokens(candidate.officialName));
  if (!left.size || !right.size) return false;
  const shared = [...left].filter(token => right.has(token)).length;
  return shared / left.size >= 0.5;
}

function itemNumberAgrees(style, candidate) {
  if ((candidate.matchedFields || []).includes('style')) return true;
  const wanted = normaliseItemId(style);
  if (!wanted) return false;
  return [candidate.itemId, candidate.style].some(value => normaliseItemId(value) === wanted);
}

function weightOf(candidate) {
  return typeof candidate.weightGrams === 'number' && Number.isFinite(candidate.weightGrams)
    ? candidate.weightGrams
    : null;
}

function sameId(a, b) {
  return Boolean(normaliseItemId(a)) && normaliseItemId(a) === normaliseItemId(b);
}

function priceGap(candidate, query) {
  const left = roundMoney(candidate?.price);
  const right = roundMoney(query?.price);
  if (left == null || right == null) return null;
  if (candidate.currency && query?.currency && candidate.currency !== query.currency) return null;
  return Math.abs(left - right);
}

function rankingGap(candidate, query) {
  if (query?.brand && fallbackPriceOnly(candidate, query.brand, query.officialFallbacks)) return null;
  return priceGap(candidate, query);
}

export function rankPriceFallback(candidates, query, closeGap = CLOSE_GAP) {
  const rows = candidates.map(candidate => {
    const gap = rankingGap(candidate, query);
    return {
      candidate,
      gap,
      description: descriptionAgrees(query.name, candidate),
      itemNumber: itemNumberAgrees(query.style, candidate),
      exact: gap === 0,
      combined: descriptionAgrees(query.name, candidate) && itemNumberAgrees(query.style, candidate),
    };
  });
  let pool;
  let tier;
  if (rows.some(row => row.combined)) {
    tier = 'a';
    pool = rows.filter(row => row.combined && row.gap != null);
    if (!pool.length) pool = rows.filter(row => row.combined);
  } else if (rows.some(row => row.exact)) {
    tier = 'b';
    pool = rows.filter(row => row.exact);
  } else {
    tier = 'c';
    pool = rows.filter(row => row.gap != null);
  }
  if (!pool.length) return { winner: null, tie: false, tier: null, weightUnresolved: false };
  const knownGaps = pool.map(row => row.gap).filter(gap => gap != null);
  const bestGap = knownGaps.length ? Math.min(...knownGaps) : 0;
  const width = closeGapWidth(query.price, closeGap);
  const band = pool.filter(row => row.gap == null || row.gap <= bestGap + width + 1e-9);
  const group = band.length ? band : pool;
  if (group.length === 1) {
    return { winner: group[0].candidate, tie: false, tier, weightUnresolved: false };
  }
  const weights = group.map(row => weightOf(row.candidate));
  if (weights.every(weight => weight != null)) {
    const lightest = Math.min(...weights);
    const light = group.filter((row, index) => weights[index] === lightest);
    if (light.length === 1) {
      return { winner: light[0].candidate, tie: false, tier, weightUnresolved: false };
    }
    return { winner: null, tie: true, tier, weightUnresolved: false };
  }
  return { winner: null, tie: true, tier, weightUnresolved: true };
}

function countedFields(candidate, brand, fallbacks) {
  const fields = candidate.matchedFields || [];
  if (brand && fallbackPriceOnly(candidate, brand, fallbacks)) return fields.filter(field => field !== 'price');
  return fields;
}

function rankByFields(candidates, brand, fallbacks) {
  if (!candidates.length) return { winner: null, tie: false };
  const scored = candidates.map(candidate => ({
    candidate,
    fields: countedFields(candidate, brand, fallbacks).length,
    confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0,
  }));
  scored.sort((a, b) => b.fields - a.fields || b.confidence - a.confidence);
  const top = scored[0];
  const tied = scored.filter(row => row.fields === top.fields && row.confidence === top.confidence);
  if (tied.length > 1) {
    const names = new Set(tied.map(row => fold(row.candidate.officialName)));
    const brands = new Set(tied.map(row => fold(row.candidate.brand)));
    if (names.size > 1 || brands.size > 1) return { winner: null, tie: true };
  }
  return { winner: top.candidate, tie: false };
}

export function normaliseMismatchField(field) {
  return FIELD_NAMES[String(field ?? '').trim()] || FIELD_NAMES[fold(field).replace(/\s+/g, '')] || '';
}

export function parseMismatches(value) {
  if (!Array.isArray(value)) return [];
  const parsed = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || entry.receiptValue === null) continue;
    const field = normaliseMismatchField(entry.field);
    if (!field) continue;
    parsed.push({
      field,
      receiptValue: entry.receiptValue ?? '',
      officialValue: entry.officialValue ?? '',
    });
  }
  return parsed;
}

export function computeMismatches(receipt, official) {
  const mismatches = [];
  const officialBrand = official?.brand ? (canonicalDisplayBrand('', official.brand) || String(official.brand).trim()) : '';
  const printedBrand = String(receipt.brand ?? '').trim();
  if (officialBrand && fold(printedBrand) !== fold(officialBrand)) {
    mismatches.push({ field: '品牌', receiptValue: printedBrand, officialValue: officialBrand });
  }
  const officialName = String(official?.officialName ?? '').trim();
  const printedName = String(receipt.name ?? '').trim();
  if (officialName && fold(printedName) !== fold(officialName)) {
    mismatches.push({ field: '品名', receiptValue: printedName, officialValue: officialName });
  }
  const officialPrice = official?.ignorePrice ? null : roundMoney(official?.price);
  if (officialPrice != null && receipt.price != null) {
    const currencyClash = Boolean(official?.currency && receipt.currency && official.currency !== receipt.currency);
    if (currencyClash || officialPrice !== roundMoney(receipt.price)) {
      mismatches.push({
        field: receipt.priceField || '采购商品原价',
        receiptValue: receipt.price,
        officialValue: officialPrice,
      });
    }
  }
  const officialId = String(official?.itemId ?? '').trim();
  const printedId = String(receipt.itemId ?? '').trim();
  if (officialId && normaliseItemId(officialId) !== normaliseItemId(printedId)) {
    mismatches.push({ field: '品牌货号', receiptValue: printedId, officialValue: officialId });
  }
  return mismatches;
}

export function mergeMismatches(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const entry of group || []) {
      if (!entry?.field || entry.receiptValue === null || seen.has(entry.field)) continue;
      seen.add(entry.field);
      merged.push(entry);
    }
  }
  return merged;
}

// Primary official domain first. A listed fallback (chanel.cn) is used only when
// that look-up's primary domain was blocked or errored. A fallback page confirms
// existence, name and ref. Its price is never used for matching or ranking.
export const DEFAULT_OFFICIAL_FALLBACKS = {
  Chanel: { primary: ['chanel.com'], fallbacks: ['chanel.cn'] },
};

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function matchesDomain(host, domain) {
  const bare = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!host || !bare) return false;
  return host === bare || host.endsWith('.' + bare);
}

function fallbackSpec(brand, table = DEFAULT_OFFICIAL_FALLBACKS) {
  const name = canonicalBrand(brand) || String(brand || '').trim();
  const spec = table?.[name] || {};
  return {
    primary: (spec.primary || []).map(domain => String(domain).toLowerCase()),
    fallbacks: (spec.fallbacks || []).map(domain => String(domain).toLowerCase()),
  };
}

function placeOf(url, domains) {
  const host = hostOf(url);
  const domain = domains.find(name => matchesDomain(host, name)) || host;
  let locale = '';
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean)[0] || '';
    if (/^[a-z]{2}$/i.test(segment)) locale = `/${segment.toLowerCase()}`;
  } catch { /* a host without a path still names the fallback */ }
  return `${domain}${locale}`;
}

function mentionsBlocked(entry, domain) {
  if (entry == null || entry === false) return false;
  if (entry === true) return true;
  const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
  if (!text.toLowerCase().includes(String(domain).toLowerCase())) return false;
  if (typeof entry === 'object' && (entry.blocked === true || entry.status === 403 || Number(entry.status) >= 500)) return true;
  return /403|blocked|denied|timeout|failed|error/i.test(text);
}

function accessSignals(response) {
  const bags = [response, response?.extra].filter(entry => entry && typeof entry === 'object');
  const signals = [];
  for (const bag of bags) {
    signals.push(bag.unavailableReason, bag.primaryBlocked);
    for (const key of ['sourceErrors', 'blockedDomains', 'officialErrors']) {
      if (Array.isArray(bag[key])) signals.push(...bag[key]);
    }
  }
  return signals;
}

export function primaryAccess(response, brand, table = DEFAULT_OFFICIAL_FALLBACKS) {
  const { primary } = fallbackSpec(brand, table);
  const signals = accessSignals(response);
  const domain = primary.find(name => signals.some(entry => mentionsBlocked(entry, name))) || null;
  return { blocked: Boolean(domain), domain };
}

function fallbackPriceOnly(candidate, brand, table) {
  return officialSource(candidate, brand, table, { primaryBlocked: true }).fallbackOnly;
}

export function officialSource(candidate, brand, table = DEFAULT_OFFICIAL_FALLBACKS, access = {}) {
  const spec = fallbackSpec(brand, table);
  const urls = candidate?.sourceUrls || [];
  const onPrimaryUrl = urls.some(url => spec.primary.some(domain => matchesDomain(hostOf(url), domain)));
  const fallbackUrl = urls.find(url => spec.fallbacks.some(domain => matchesDomain(hostOf(url), domain)));
  const fallbackUrlsOnly = Boolean(fallbackUrl) && !onPrimaryUrl;
  const serverPrimary = candidate?.onOfficialSite === true && !fallbackUrlsOnly;
  const allowed = onPrimaryUrl || serverPrimary || (fallbackUrlsOnly && access.primaryBlocked);
  const blockedName = access.blockedDomain || spec.primary[0] || 'official site';
  const place = fallbackUrl ? placeOf(fallbackUrl, spec.fallbacks) : '';
  const gbpConfirmed = String(candidate?.currency || '').trim().toUpperCase() === 'GBP';
  const priceClause = gbpConfirmed ? '' : '; GBP price cannot be confirmed on the fallback path';
  return {
    acceptable: allowed,
    onPrimary: onPrimaryUrl || serverPrimary,
    fallbackOnly: Boolean(fallbackUrlsOnly && access.primaryBlocked && allowed),
    fallbackNote: fallbackUrlsOnly && access.primaryBlocked ? `${blockedName} blocked; confirmed on ${place}${priceClause}` : '',
  };
}

function idMatch(candidate, itemId) {
  if (!itemId) return false;
  if (sameId(candidate.itemId, itemId)) return true;
  return candidate.matchType === 'id' && (candidate.matchedFields || []).includes('itemId') && sameId(candidate.itemId, itemId);
}

function describeSelection(ranked, extra) {
  const source = ranked.winner
    ? officialSource(ranked.winner, extra.brand, extra.fallbacks, extra.access)
    : { onPrimary: false, fallbackOnly: false, fallbackNote: '' };
  return {
    ...ranked,
    onPrimary: Boolean(source.onPrimary),
    fallbackOnly: source.fallbackOnly,
    fallbackNote: source.fallbackNote,
    ...extra.rest,
  };
}

export function selectCandidate(candidates, query, { partial = false, closeGap = CLOSE_GAP, officialFallbacks = DEFAULT_OFFICIAL_FALLBACKS, primaryBlocked = false, blockedDomain = null } = {}) {
  const access = { primaryBlocked, blockedDomain };
  const judged = (candidates || []).map(candidate => ({ candidate, ...officialSource(candidate, query.brand, officialFallbacks, access) }));
  const official = judged.filter(item => item.acceptable).map(item => item.candidate);
  const corroboration = judged.filter(item => !item.acceptable).map(item => item.candidate);
  const idMatches = query.itemId ? official.filter(candidate => idMatch(candidate, query.itemId)) : [];
  const attach = (ranked, rest) => describeSelection(ranked, { brand: query.brand, fallbacks: officialFallbacks, access, rest });
  if (idMatches.length) {
    const ranked = rankByFields(idMatches, query.brand, officialFallbacks);
    return attach(ranked, { matchType: ranked.winner ? 'id' : null, fallback: false, corroboration, considered: idMatches });
  }
  const multi = official.filter(candidate => candidate.matchType !== 'price-fallback');
  const fallbackPool = official.filter(candidate => candidate.matchType === 'price-fallback');
  if (!query.itemId && multi.length) {
    const ranked = rankByFields(multi, query.brand, officialFallbacks);
    return attach(ranked, { matchType: ranked.winner ? (ranked.winner.matchType || 'multi-field') : null, fallback: false, corroboration, considered: multi });
  }
  if (partial || !fallbackPool.length) {
    return attach({ winner: null, tie: false }, { matchType: null, fallback: false, corroboration, considered: fallbackPool, weightUnresolved: false });
  }
  const ranked = rankPriceFallback(fallbackPool, { ...query, officialFallbacks }, closeGap);
  return attach(ranked, {
    matchType: ranked.winner ? 'price-fallback' : null,
    fallbackTier: ranked.tier,
    fallback: true,
    weightUnresolved: ranked.weightUnresolved,
    corroboration,
    considered: fallbackPool,
  });
}
