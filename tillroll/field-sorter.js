// Printed-item field sorter from PR #1, plus the v2 reader-stage brand/name helper.
//
// sortItemFields({ item, ... }) is the official PR #1 reader API (returns { item, issues }).
// sortItemFields({ brand, name, itemId }, opts) is the v2 sanity-run stage API
// (returns brand/name flags). hasNonBrandWord and isNumericPrice serve the stage tests.

// Move printed brand words and codes into their own fields.
// A brand word that sits inside a product name, followed by a real noun, stays in the name.
import {isGtin} from './product-code.js';

const clean = value => String(value ?? '').trim();
const escapeReg = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longer phrases are listed before shorter ones so "Christian Dior" wins over "Dior".
const dictionary = [
  ['Dior', ['CHRISTIAN DIOR', 'DIOR MENS', 'DIOR', 'CD']],
  ['Louis Vuitton', ['LOUIS VUITTON', 'LV']],
  ['Bottega Veneta', ['BOTTEGA VENETA', 'BV']],
  ['Saint Laurent', ['YVES SAINT LAURENT', 'SAINT LAURENT', 'YSL']],
  ['Gucci', ['GUCCI']],
  ['Chanel', ['CHANEL']],
  ['Hermès', ['HERMÈS', 'HERMES']],
  ['Prada', ['PRADA']],
  ['Celine', ['CÉLINE', 'CELINE']],
  ['Loewe', ['LOEWE']],
  ['Fendi', ['FENDI']],
  ['Burberry', ['BURBERRY']],
  ['Balenciaga', ['BALENCIAGA']],
  ['Givenchy', ['GIVENCHY']],
  ['Valentino', ['VALENTINO']],
  ['Moncler', ['MONCLER']],
  ['Cartier', ['CARTIER']],
  ['Van Cleef & Arpels', ['VAN CLEEF & ARPELS', 'VAN CLEEF', 'VCA', 'YCA']],
  ['Miu Miu', ['MIU MIU']],
  ['Bulgari', ['BULGARI', 'BVLGARI']],
  ['Tiffany', ['TIFFANY & CO', 'TIFFANY']],
  ['Loro Piana', ['LORO PIANA']],
  ['Brunello Cucinelli', ['BRUNELLO CUCINELLI']],
  ['The Row', ['THE ROW']],
  ['Canada Goose', ['CANADA GOOSE', 'CG']],
  ['N.Peal', ['N.PEAL', 'N. PEAL', 'N PEAL']],
  ['Max Mara', ['MAX MARA']],
];

const aliases = dictionary.flatMap(([brand, names]) => names.map(alias => ({brand, alias, short: alias.length <= 3 && !/\s/.test(alias)})));

function aliasReg(alias) {
  const body = escapeReg(alias).replace(/\\ /g, '\\s+');
  return new RegExp('(?<![A-Za-z0-9])(?:' + body + ')(?![A-Za-z0-9])', 'i');
}

// A price is a number. £1,234.00 is 1234. £abc is not a price.
export function numericPrice(value) {
  if (value == null || value === '') return {value: null, issue: null};
  if (typeof value === 'number') return Number.isFinite(value)
    ? {value, issue: null}
    : {value: null, issue: 'The price is not a number.'};
  const text = clean(value);
  if (!text) return {value: null, issue: null};
  const money = text.replace(/\s+/g, '').match(/^[£$€¥]?(?:-)?(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d{2}))?$/);
  if (!money) return {value: null, issue: 'The price is not a number (' + text + ').'};
  const whole = money[1].replace(/,/g, '');
  const amount = Number(money[2] ? whole + '.' + money[2] : whole);
  return Number.isFinite(amount) ? {value: text.trim().startsWith('-') ? -amount : amount, issue: null}
    : {value: null, issue: 'The price is not a number (' + text + ').'};
}

function takeCodes(tokens, row) {
  const kept = [];
  for (const token of tokens) {
    const compact = token.replace(/[£$€¥,\s]/g, '');
    if (/^\d{4}$/.test(compact) && row.concessionCode === compact) continue;
    if (/^\d{10}$/.test(compact) && (/^9999999\d{3}$/.test(compact) || row.concessionCode)) {
      row.internalCode = row.internalCode || compact;
      if (row.itemId === compact) row.itemId = null;
      continue;
    }
    if (/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(compact) && isGtin(compact)) {
      row.ean = row.ean || compact;
      if (row.itemId === compact) row.itemId = null;
      continue;
    }
    if (/^[A-Za-z]{1,6}\d{2,}[A-Za-z0-9-]*$/.test(token)) {
      row.styleRef = row.styleRef || token;
      continue;
    }
    kept.push(token);
  }
  return kept;
}

function edgeBrand(text) {
  const source = clean(text);
  if (!source) return null;
  for (const {brand, alias} of aliases) {
    const pattern = aliasReg(alias);
    const match = pattern.exec(source);
    if (!match) continue;
    const before = source.slice(0, match.index).trim();
    const after = source.slice(match.index + match[0].length).trim();
    // Letters on both sides of a brand keep it in the name. "Mini Acme Widget" stays whole.
    if (before && after && /\p{L}/u.test(after)) continue;
    if (before && after) continue;
    return {brand, raw: match[0], before, after};
  }
  return null;
}

function sortPrintedItemFields(item) {
  const row = {...(item || {})};
  const issues = [];
  for (const key of ['amount', 'unitPrice']) {
    if (row[key] == null || row[key] === '') continue;
    const parsed = numericPrice(row[key]);
    if (parsed.issue) {
      issues.push({field: key, reason: 'unreadable_price', evidence: parsed.issue});
      row[key] = null;
    } else if (typeof row[key] !== 'number') row[key] = parsed.value;
  }
  if (!row.styleRef && typeof row.itemId === 'string' && /^[A-Za-z]{1,6}\d{2,}[A-Za-z0-9-]*$/.test(row.itemId))
    row.styleRef = row.itemId;
  const original = clean(row.item);
  const tokens = takeCodes(original.split(/\s+/).filter(Boolean), row);
  let name = tokens.join(' ');
  const found = edgeBrand(name);
  if (found) {
    row.brand = found.brand;
    row.brandRaw = row.brandRaw || found.raw;
    const stripped = clean([found.before, found.after].filter(Boolean).join(' '));
    if (stripped !== name && row.receiptItem == null) row.receiptItem = original;
    name = stripped;
  } else if (!row.brand && row.brandRaw) {
    const fromRaw = edgeBrand(row.brandRaw) || aliases.map(entry => ({...entry, pattern: aliasReg(entry.alias)}))
      .find(entry => entry.pattern.test(row.brandRaw));
    if (fromRaw) row.brand = fromRaw.brand;
  }
  row.item = name || null;
  if (row.itemId && (row.itemId === row.concessionCode || row.itemId === row.internalCode || /^9999999\d{3}$/.test(String(row.itemId)) || (/^\d{10}$/.test(String(row.itemId)) && row.concessionCode)))
    row.itemId = null;
  if (!row.item) issues.push({field: 'item', reason: 'item_name_missing', evidence: original ? 'The item line is only a brand or a code (' + original + ').' : 'The item description is missing.'});
  return {item: row, issues};
}

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

function sortStageItemFields({ brand, name, itemId } = {}, opts = {}) {
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


export function sortItemFields(input, opts) {
  if (input && typeof input === 'object' && 'name' in input && !('item' in input)) {
    return sortStageItemFields(input, opts);
  }
  return sortPrintedItemFields(input);
}
