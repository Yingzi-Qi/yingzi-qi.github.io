// Shared 品牌 / 品名 field sorter, used by the v2 reader stage before the verifier.
//
// This file is a local follow-up stand-in. tillroll/field-sorter.js is not on
// PR #1 (head 060a2f8) or on the current default-branch tillroll/ tree.
// Related helpers already live in PR #1 tillroll/receipt-rules.js
// (nonItemName, toPaymentMethod, brandItemIdCandidate). When PR #1 lands an
// official field-sorter.js, align this module and the sanity.js import.

const fold = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CODE_TOKEN = /^(?:#?\d{4,}|\d+[A-Z0-9]{2,}|[A-Z]?\d{6,}|9999999\d{3})$/i;

function defaultPhrases() {
  return [
    'Christian Dior', 'Dior', 'Louis Vuitton', 'Van Cleef & Arpels', 'Van Cleef and Arpels', 'Van Cleef', 'Chanel',
    'Hermès', 'Hermes', 'Cartier', 'Gucci', 'Prada', 'Miu Miu', 'Rolex', 'Tiffany & Co.', 'Tiffany and Co', 'Tiffany',
    'Bulgari', 'Bvlgari', 'Celine', 'Céline', 'Loewe', 'Saint Laurent', 'Yves Saint Laurent', 'YSL', 'Burberry',
    'Fendi', 'Balenciaga', 'Bottega Veneta', 'Valentino', 'Givenchy', 'Moncler', 'Goyard', 'Omega', 'Graff',
    'Chloé', 'Chloe', 'Jimmy Choo', 'Christian Louboutin', 'Louboutin', 'Alexander McQueen', 'McQueen',
    'MAC', 'Jo Malone London', 'Jo Malone', 'La Mer', 'Tom Ford', 'Montblanc', 'Chopard', 'Boucheron',
    'Dolce & Gabbana', 'Dolce and Gabbana', 'Versace', 'Off-White', 'New Balance',
  ].map(phrase => ({ phrase, canonical: phrase }));
}

export function isNumericPrice(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[£$€¥,\s]/g, '').replace(/^-/, '-'));
  return Number.isFinite(n);
}

function phraseList(opts = {}) {
  const extra = opts.phrases || [];
  const all = [...extra, ...defaultPhrases()];
  const seen = new Set();
  const out = [];
  for (const p of all) {
    const phrase = typeof p === 'string' ? p : p.phrase;
    const canonical = typeof p === 'string' ? (opts.canonicalBrand ? opts.canonicalBrand(p) : p) : (p.canonical || p.phrase);
    const key = fold(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ phrase, canonical: opts.canonicalBrand ? (opts.canonicalBrand(canonical) || canonical) : canonical, folded: key });
  }
  out.sort((a, b) => b.folded.length - a.folded.length);
  return out;
}

export function findBrandInName(name, opts = {}) {
  const text = fold(name);
  if (!text) return null;
  for (const p of phraseList(opts)) {
    const re = new RegExp(`(?:^|[^a-z0-9&])${escapeRe(p.folded)}(?:[^a-z0-9&]|$)`);
    if (re.test(` ${text} `)) return p;
  }
  return null;
}

export function stripBrandAndCodes(name, brandPhrase) {
  let t = String(name ?? '').trim();
  if (!t) return '';
  const phrases = [brandPhrase].filter(Boolean);
  for (const p of phrases) {
    const folded = fold(p);
    if (!folded) continue;
    t = t.replace(new RegExp(`(?:^|\\s+|[^A-Za-z0-9])*${escapeRe(p)}(?:\\s+|[^A-Za-z0-9])*`, 'ig'), ' ');
    t = t.replace(new RegExp(`(?:^|\\s+)${escapeRe(folded)}(?=\\s+|$)`, 'ig'), ' ');
  }
  t = t.replace(/\b\d{6,}\b/g, ' ').replace(/\b9999999\d{3}\b/g, ' ');
  return t.replace(/[\s,;:/\-_]+/g, ' ').trim();
}

export function hasNonBrandWord(name, brandPhrase, opts = {}) {
  const leftover = stripBrandAndCodes(name, brandPhrase);
  if (!leftover) return false;
  const found = findBrandInName(leftover, opts);
  const rest = found ? stripBrandAndCodes(leftover, found.phrase) : leftover;
  const words = rest.split(/\s+/).filter(w => w && !CODE_TOKEN.test(w) && /[A-Za-z\u00C0-\u024F]/.test(w));
  return words.length > 0;
}

export function sortItemFields({ brand, name, itemId } = {}, opts = {}) {
  const rawBrand = (brand == null ? '' : String(brand)).trim();
  const rawName = (name == null ? '' : String(name)).trim();
  const found = findBrandInName(rawName, opts);
  const brandFromName = found ? found.canonical : null;
  const brandMoved = !rawBrand && Boolean(brandFromName);
  const derivedBrand = rawBrand || brandFromName || null;
  const phraseForStrip = found?.phrase || derivedBrand;
  const leftover = stripBrandAndCodes(rawName, phraseForStrip);
  const nameHasNonBrandWord = hasNonBrandWord(rawName, phraseForStrip, opts);
  const onlyCodeAndBrand = Boolean(rawName) && !nameHasNonBrandWord && (found || rawBrand) && (/\d{6,}/.test(rawName) || leftover === '');
  const brandOnly = Boolean(rawName) && !nameHasNonBrandWord && Boolean(found || (rawBrand && fold(rawName) === fold(rawBrand))) && leftover === '' && !/\d{6,}/.test(rawName);
  const junk = !rawName || onlyCodeAndBrand || brandOnly;
  let nextName = rawName;
  if (brandMoved && leftover) nextName = leftover;
  else if (brandMoved && (brandOnly || onlyCodeAndBrand)) nextName = leftover || '';
  return {
    brand: derivedBrand,
    name: nextName,
    brandMoved,
    nameHasNonBrandWord,
    brandOnly,
    codePlusBrand: onlyCodeAndBrand && !brandOnly,
    junk,
    itemId: itemId ?? null,
  };
}
