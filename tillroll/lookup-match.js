// Accept an official-site candidate, then compare it with the receipt.
// Price fallback ranks only candidates the service already marked price-fallback,
// and only after the item id matched nothing. It does not run on a paused or partial result.

import { canonicalBrand, fold, normaliseItemId } from './brand-aliases.js';
import { canonicalDisplayBrand, roundMoney } from './lookup-policy.js';

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
  if (query?.brand && officialSource(candidate, query.brand, query.officialMirrors).mirrorOnly) return null;
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

function countedFields(candidate, brand, mirrors) {
  const fields = candidate.matchedFields || [];
  if (brand && officialSource(candidate, brand, mirrors).mirrorOnly) return fields.filter(field => field !== 'price');
  return fields;
}

function rankByFields(candidates, brand, mirrors) {
  if (!candidates.length) return { winner: null, tie: false };
  const scored = candidates.map(candidate => ({
    candidate,
    fields: countedFields(candidate, brand, mirrors).length,
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

// Provisional. chanel.com answers 403 to bots, so a listed mirror can stand in for
// the primary official domain. A mirror-only confirmation stays Amber.
export const DEFAULT_OFFICIAL_MIRRORS = { Chanel: ['chanel.cn'] };
const PRIMARY_DOMAINS = { Chanel: ['chanel.com'] };

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function matchesDomain(host, domain) {
  const bare = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!host || !bare) return false;
  return host === bare || host.endsWith('.' + bare);
}

export function officialSource(candidate, brand, mirrors = DEFAULT_OFFICIAL_MIRRORS) {
  const name = canonicalBrand(brand) || String(brand || '').trim();
  const hosts = (candidate?.sourceUrls || []).map(hostOf).filter(Boolean);
  const primary = PRIMARY_DOMAINS[name] || [];
  const listed = mirrors?.[name] || [];
  const onPrimary = hosts.some(host => primary.some(domain => matchesDomain(host, domain)));
  const mirrorDomains = listed.filter(domain => hosts.some(host => matchesDomain(host, domain)));
  const mirrorOnly = mirrorDomains.length > 0 && !onPrimary;
  return {
    acceptable: candidate?.onOfficialSite === true || mirrorOnly,
    mirrorOnly,
    mirrorNote: mirrorOnly ? mirrorDomains.map(domain => `official mirror ${domain}`).join(' ') : '',
  };
}

function idMatch(candidate, itemId) {
  if (!itemId) return false;
  if (sameId(candidate.itemId, itemId)) return true;
  return candidate.matchType === 'id' && (candidate.matchedFields || []).includes('itemId') && sameId(candidate.itemId, itemId);
}

function describeSelection(ranked, extra) {
  const source = ranked.winner ? officialSource(ranked.winner, extra.brand, extra.mirrors) : { mirrorOnly: false, mirrorNote: '' };
  return { ...ranked, mirrorOnly: source.mirrorOnly, mirrorNote: source.mirrorNote, ...extra.rest };
}

export function selectCandidate(candidates, query, { partial = false, closeGap = CLOSE_GAP, officialMirrors = DEFAULT_OFFICIAL_MIRRORS } = {}) {
  const judged = (candidates || []).map(candidate => ({ candidate, ...officialSource(candidate, query.brand, officialMirrors) }));
  const official = judged.filter(item => item.acceptable).map(item => item.candidate);
  const corroboration = judged.filter(item => !item.acceptable).map(item => item.candidate);
  const idMatches = query.itemId ? official.filter(candidate => idMatch(candidate, query.itemId)) : [];
  const attach = (ranked, rest) => describeSelection(ranked, { brand: query.brand, mirrors: officialMirrors, rest });
  if (idMatches.length) {
    const ranked = rankByFields(idMatches, query.brand, officialMirrors);
    return attach(ranked, { matchType: ranked.winner ? 'id' : null, fallback: false, corroboration, considered: idMatches });
  }
  const multi = official.filter(candidate => candidate.matchType !== 'price-fallback');
  const fallbackPool = official.filter(candidate => candidate.matchType === 'price-fallback');
  if (!query.itemId && multi.length) {
    const ranked = rankByFields(multi, query.brand, officialMirrors);
    return attach(ranked, { matchType: ranked.winner ? (ranked.winner.matchType || 'multi-field') : null, fallback: false, corroboration, considered: multi });
  }
  if (partial || !fallbackPool.length) {
    return attach({ winner: null, tie: false }, { matchType: null, fallback: false, corroboration, considered: fallbackPool, weightUnresolved: false });
  }
  const ranked = rankPriceFallback(fallbackPool, { ...query, officialMirrors }, closeGap);
  return attach(ranked, {
    matchType: ranked.winner ? 'price-fallback' : null,
    fallbackTier: ranked.tier,
    fallback: true,
    weightUnresolved: ranked.weightUnresolved,
    corroboration,
    considered: fallbackPool,
  });
}
