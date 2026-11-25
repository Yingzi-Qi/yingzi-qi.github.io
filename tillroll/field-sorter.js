// Move printed brand words and codes into their own fields.
// A brand word that sits inside a product name, followed by a real noun, stays in the name.
import {isGtin} from './product-code.js';
import {nonItemName} from './receipt-rules.js';

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

export function sortItemFields(item) {
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
  const blocked = nonItemName(original);
  if (blocked) {
    row.item = null;
    issues.push({field: 'item', reason: 'item_name_missing', evidence: blocked});
    return {item: row, issues};
  }
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
