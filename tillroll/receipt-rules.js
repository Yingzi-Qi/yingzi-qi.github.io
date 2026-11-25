// Tillroll v2 reading rules (Receipt Reader & Sanity Checker).
// Every helper here is pure: it reads printed receipt text or OCR geometry and
// never consults a look-up source. Doubts are returned as issues so that checks.js
// can raise a reading flag (Pink #FECDD3) instead of guessing a value.
import {isGtin} from './product-code.js?v=productcodes3';
import {validCalendarDate} from './purchase-date.js?v=8';

const clean = value => String(value ?? '').trim();
const loose = value => clean(value).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const pad = value => String(value).padStart(2, '0');

// ---------------------------------------------------------------------------
// 采购时间: YYYY-MM-DD HH:MM:SS, 24-hour, seconds default to 00, am/pm converted.
const clockPattern = /(?<![\d:.,])([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)(?:\s*:\s*([0-5]\d))?(?:\s*([ap])\.?\s*m\.?(?![a-z]))?(?![\d:]|[.,]\d)/i;

// Normalise one printed clock value. Returns null when the value is not a valid time.
export function normalizePurchaseTime(value) {
  const text = clean(value);
  if (!text) return null;
  const m = new RegExp('^' + clockPattern.source + '$', 'i').exec(text) ||
    /^(\d{1,2})\s*([ap])\.?\s*m\.?$/i.exec(text) && ['', /^(\d{1,2})/.exec(text)[1], '00', null, /([ap])/i.exec(text)[1]];
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]), second = m[3] == null ? 0 : Number(m[3]);
  const half = m[4]?.toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (half === 'p' ? 12 : 0);
  } else if (hour > 23) return null;
  if (minute > 59 || second > 59) return null;
  return pad(hour) + ':' + pad(minute) + ':' + pad(second);
}

// Read the purchase time from receipt text. Prefer a time printed on the same line
// as the purchase date or a Date/Time label; otherwise the first clean clock value.
export function readPurchaseTime(text) {
  const lines = clean(text).split(/\r?\n/);
  const candidates = [];
  for (const [i, line] of lines.entries()) {
    const global = new RegExp(clockPattern.source, 'gi');
    for (const m of line.matchAll(global)) {
      const time = normalizePurchaseTime(m[0]);
      if (!time) continue;
      // A time next to an expiry/return label is not the purchase time.
      if (/\b(?:expir|valid|return|open(?:ing)?|hours|ouvert|horaires)\w*/i.test(line)) continue;
      const dated = /\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}|\b(?:date|time|heure|datum|zeit)\b/i.test(line);
      candidates.push({time, printed: m[0].trim(), score: dated ? 2 : 1, line: i});
    }
  }
  if (!candidates.length) return {time: null, issue: null};
  // 00:00 is a blank clock. A real printed time on the same receipt replaces it.
  const printedTimes = candidates.filter(c => c.time !== '00:00:00');
  if (printedTimes.length) candidates.splice(0, candidates.length, ...printedTimes);
  const best = Math.max(...candidates.map(c => c.score));
  const chosen = candidates.filter(c => c.score === best);
  const distinct = [...new Set(chosen.map(c => c.time))];
  if (distinct.length > 1 && best === 2)
    return {time: chosen[0].time, issue: 'Several purchase times are printed (' + chosen.map(c => c.printed).join(' / ') + ').'};
  return {time: chosen[0].time, issue: null};
}

// Combine an ISO date and a clock value into the 采购时间 column value.
export function purchaseTimestamp(date, time) {
  if (!validCalendarDate(clean(date))) return null;
  const clock = normalizePurchaseTime(time);
  return clock ? clean(date) + ' ' + clock : null;
}

// ---------------------------------------------------------------------------
// 采购商品方法: payment tender only, never the purchase channel.
const tenders = [
  ['Alipay', /\b(?:ali\s*pay)\b|支付宝/i, 1],
  ['WeChat', /\b(?:we\s*chat(?:\s*pay)?|weixin(?:\s*pay)?)\b|微信/i, 1],
  ['Apple Pay', /\bapple\s*pay\b/i, 1],
  ['Google Pay', /\b(?:google\s*pay|g\s*pay)\b/i, 1],
  ['Samsung Pay', /\bsamsung\s*pay\b/i, 1],
  ['PayPal', /\bpay\s*pal\b/i, 1],
  ['Klarna', /\bklarna\b/i, 1],
  ['UnionPay', /\b(?:union\s*pay|china\s+union\s*pay|\bcup\b)\b|银联/i, 2],
  ['Amex', /\b(?:amex|american\s+express)\b/i, 2],
  ['Diners Club', /\bdiners(?:\s+club)?\b/i, 2],
  ['JCB', /\bjcb\b/i, 2],
  ['Discover', /\bdiscover(?:\s+card)?\b/i, 2],
  ['Maestro', /\bmaestro\b/i, 2],
  ['Mastercard', /\b(?:master\s*card|debit\s+master\s*card|mc\s+debit)\b/i, 2],
  ['Visa', /\bvisa(?:\s+(?:debit|credit|electron))?\b/i, 2],
  ['Carte Bancaire', /\b(?:carte\s+bleue|carte\s+bancaire|carte\s+cb)\b/i, 2],
  ['Gift Card', /\b(?:gift\s*card|gift\s*voucher|carte\s+cadeau)\b/i, 3],
  ['Cash', /\b(?:cash|esp[eè]ces|bargeld|contanti|efectivo|tunai)\b/i, 3],
  ['Card', /\b(?:card\s+(?:sales?|payment|tender)|credit\s+card|debit\s+card|contactless|chip\s*(?:&|and)\s*pin|eftpos)\b/i, 4],
];
const channelTerms = /^(?:online|on-?line\s+(?:order|purchase|shop)|in[-\s]?store|store|shop|website|web(?:\s*shop|\s*order)?|app|mobile\s+app|e-?commerce|mail\s+order|phone\s+order|telephone\s+order|click\s*(?:&|and)\s*collect|delivery|home\s+delivery|boutique|concession|marketplace|instore|retail|duty\s*free|tax\s*free)$|\.com\b/i;
const tenderNames = new Map(tenders.map(([name]) => [loose(name), name]));

// Normalise a recorded tender. `{tender}` is the canonical name; `channel` is true when
// the value describes how the purchase was made rather than how it was paid.
export function normalizeTender(value) {
  const text = clean(value);
  if (!text) return {tender: null, channel: false, known: false};
  if (channelTerms.test(text)) return {tender: null, channel: true, known: false};
  if (tenderNames.has(loose(text))) return {tender: tenderNames.get(loose(text)), channel: false, known: true};
  const hits = tenders.filter(([, pattern]) => pattern.test(text));
  if (hits.length) return {tender: hits.sort((a, b) => a[2] - b[2])[0][0], channel: false, known: true};
  if (/^cb$/i.test(text)) return {tender: 'Carte Bancaire', channel: false, known: true};
  if (/^(?:carte|card)$/i.test(text)) return {tender: 'Card', channel: false, known: true};
  return {tender: text, channel: false, known: false};
}

// 采购商品方法 is exactly one of these four spellings. UnionPay is matched before
// any generic card scheme. Cash, gift cards, wallets and anything unreadable stay null.
const paymentMethodNames = new Map([
  ['unionpay', 'UnionPay'], ['alipay', 'Alipay'], ['wechat', 'WeChat'],
  ['visa', 'Card'], ['mastercard', 'Card'], ['maestro', 'Card'], ['amex', 'Card'],
  ['dinersclub', 'Card'], ['jcb', 'Card'], ['discover', 'Card'], ['cartebancaire', 'Card'], ['card', 'Card'],
]);
export function toPaymentMethod(value) {
  const text = clean(value);
  if (!text) return {method: null, reason: 'No payment tender was read.'};
  if (/\b(?:union\s*pay|china\s+union\s*pay|\bcup\b)\b|银联/i.test(text)) return {method: 'UnionPay', reason: null};
  if (/\balipay\b|支付宝/i.test(text)) return {method: 'Alipay', reason: null};
  if (/\b(?:we\s*chat(?:\s*pay)?|weixin(?:\s*pay)?)\b|微信/i.test(text)) return {method: 'WeChat', reason: null};
  if (/\b(?:gift\s*card|gift\s*voucher|cash|pay\s*pal|klarna)\b/i.test(text))
    return {method: null, reason: 'The tender “' + text + '” is not UnionPay, Card, Alipay or WeChat.'};
  // A wallet with no card scheme is still a card payment. Cash and gift cards stay null.
  if (paymentMethodNames.get(loose(text)) === 'Card' || /\b(?:visa|master\s*card|maestro|amex|american\s+express|discover|jcb|diners|carte\s+(?:bleue|bancaire)|\bcb\b|credit\s+card|debit\s+card|contactless|chip(?:\s*(?:&|and)\s*pin)?|eftpos|apple\s*pay|google\s*pay|g\s*pay|samsung\s*pay)\b/i.test(text))
    return {method: 'Card', reason: null};
  return {method: null, reason: 'The tender “' + text + '” is not UnionPay, Card, Alipay or WeChat.'};
}

// Drop a printed card number or last-4 from tender text. The tender name itself stays.
export function dropCardDigits(value) {
  return clean(value)
    .replace(/\b\d{12,19}\b/g, ' ')
    .replace(/\b(?:ending(?:\s+in)?|last\s*4)\s*[:#]?\s*\d{2,4}\b/gi, ' ')
    .replace(/(?:[*•xX]{2,})\s*\d{2,4}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const storeInternalCode = code => {
  const compact = clean(code).replace(/\s+/g, '');
  return /^\d{10}$/.test(compact) || /^9999999\d{3}$/.test(compact);
};
const eanCode = code => /^\d{13}$/.test(clean(code).replace(/\s+/g, ''));

// 品牌货号 candidate. Style ref, then a brand product code, then an EAN.
// A concession or any store-internal 10-digit code is never a candidate.
export function brandItemIdCandidate(item) {
  if (!item || typeof item !== 'object') return null;
  const style = clean(item.styleRef);
  if (style && !storeInternalCode(style) && !eanCode(style) && style !== clean(item.concessionCode))
    return {value: style, source: 'styleRef'};
  const own = [item.itemId, item.sku].map(clean).find(code => code && !storeInternalCode(code) && !eanCode(code)
    && code !== clean(item.concessionCode) && code !== clean(item.internalCode));
  if (own) return {value: own, source: 'brandProductCode'};
  const ean = clean(item.ean) || [item.itemId, item.sku].map(clean).find(eanCode) || '';
  if (ean && eanCode(ean)) return {value: ean.replace(/\s+/g, ''), source: 'ean'};
  return null;
}

// A style, ref or model code printed on its own line. Store-internal numbers are left out.
export function readPrintedStyleRef(text) {
  const source = clean(text);
  if (/\d[.,]\d{2}/.test(source)) return null;
  const match = /^(?:style(?:\s*(?:\/\s*sku|ref(?:erence)?|code|no\.?|number))?|ref(?:erence)?\.?|model(?:\s*(?:no\.?|number|code))?)\s*[:#-]?\s*(.+)$/i.exec(source);
  if (!match) return null;
  const body = match[1].trim();
  const code = body.split(/\s+(?:[-–—](?:\s*:)?|[·|])\s+/)[0].replace(/[,.;]+$/, '').trim();
  if (/\s/.test(code) || !/^[A-Za-z0-9]/.test(code)) return null;
  const rest = body.slice(code.length);
  if (rest && !/^\s*(?:[-–—]|[·|])\s+\S+$/.test(rest)) return null;
  if (!code || !/\d/.test(code) || storeInternalCode(code) || eanCode(code) || /^NT[0O1]?\d/i.test(code)) return null;
  return code;
}

// Read the tender from receipt text. A wallet (Apple Pay, Alipay…) outranks the card
// scheme printed with it; otherwise the first printed tender is used.
export function readTender(text) {
  const lines = clean(text).split(/\r?\n/);
  const hits = [];
  for (const [i, line] of lines.entries()) {
    // Promotional and policy wording mentions tenders without paying with them.
    if (/\b(?:accept(?:ed|s)?|welcome|we\s+take|cashback\s+available|cash\s*back\s+up\s+to|refund(?:ed)?\s+to)\b/i.test(line)) continue;
    for (const [name, pattern, rank] of tenders) {
      const m = pattern.exec(line);
      if (!m) continue;
      // "Change" or "cash back" lines describe the result of a cash tender only when cash is paid.
      if (name === 'Cash' && /\b(?:cash\s*back|cashier|cash\s+register)\b/i.test(line)) continue;
      hits.push({name, rank, line: i, index: m.index});
    }
  }
  if (!hits.length) return null;
  const wallets = hits.filter(h => h.rank === 1);
  const pool = wallets.length ? wallets : hits.filter(h => h.rank < 4).length ? hits.filter(h => h.rank < 4) : hits;
  return pool.sort((a, b) => a.line - b.line || a.index - b.index || a.rank - b.rank)[0].name;
}

// ---------------------------------------------------------------------------
// 品牌货号: strip repeated brand names; keep digits and leading zeros; reject values
// that are dates, prices, phone numbers or card last-4.
const separators = /[\s\-_/.:|·,]+/;
function brandTokens(brand) {
  const words = clean(brand).split(/[\s&+/,-]+/).map(loose).filter(w => w.length >= 2);
  const whole = loose(brand);
  return {whole, words: new Set(words.filter(w => !/^(?:and|the|de|la|le|of|et)$/.test(w)))};
}
function compactDate(value) {
  const forms = [];
  if (/^\d{8}$/.test(value)) {
    forms.push(value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6));
    forms.push(value.slice(4) + '-' + value.slice(2, 4) + '-' + value.slice(0, 2));
    forms.push(value.slice(4) + '-' + value.slice(0, 2) + '-' + value.slice(2, 4));
    return forms.filter(f => /^(?:19|20)\d{2}-/.test(f) && validCalendarDate(f));
  }
  if (/^\d{6}$/.test(value)) {
    const y = v => '20' + v;
    forms.push(y(value.slice(0, 2)) + '-' + value.slice(2, 4) + '-' + value.slice(4));
    forms.push(y(value.slice(4)) + '-' + value.slice(2, 4) + '-' + value.slice(0, 2));
    forms.push(y(value.slice(4)) + '-' + value.slice(0, 2) + '-' + value.slice(2, 4));
    return forms.filter(validCalendarDate);
  }
  return [];
}
const digitsOf = value => clean(value).replace(/\D/g, '');

// Returns {code, issue, rejected}. `code` keeps every printed digit and leading zero.
// `rejected` is true when the value is not a product code at all (it is cleared).
export function cleanProductCode(value, {brand = null, card = null, phone = null, date = null} = {}) {
  const raw = clean(value);
  if (!raw) return {code: null, issue: null, rejected: false};
  let code = raw;
  let issue = null;
  if (clean(brand)) {
    const {whole, words} = brandTokens(brand);
    const isBrand = token => loose(token) === whole || words.has(loose(token));
    // Alternating [token, separator, token, …] keeps the printed separators inside the code.
    const pieces = raw.split(/([\s\-_/.:|·,]+)/).filter(p => p !== '');
    const tokens = pieces.filter(p => !/^[\s\-_/.:|·,]+$/.test(p));
    if (tokens.length && tokens.every(isBrand))
      return {code: null, issue: 'The printed code only repeats the brand name.', rejected: true};
    let first = 0, last = pieces.length - 1;
    const sep = p => /^[\s\-_/.:|·,]+$/.test(p);
    // Strip repeated brand names before and after the code ("GUCCI GUCCI 0123456").
    while (first <= last && (sep(pieces[first]) || isBrand(pieces[first]))) first++;
    while (last >= first && (sep(pieces[last]) || isBrand(pieces[last]))) last--;
    const middle = pieces.slice(first, last + 1);
    if (middle.some(p => !sep(p) && isBrand(p))) {
      code = middle.filter(p => sep(p) || !isBrand(p)).join('').replace(/([\s\-_/.:|·,])[\s\-_/.:|·,]+/g, '$1');
      issue = 'The brand name was printed inside the product code. Check the printed code.';
    } else code = middle.join('');
    // The brand fused onto the code without a separator is ambiguous: keep it and flag.
    if (whole.length >= 3 && loose(code).startsWith(whole) && loose(code) !== whole && /\d/.test(code))
      issue ||= 'The product code may begin with the brand name. Check the printed code.';
  }
  code = code.trim();
  const compact = code.replace(/\s+/g, '');
  if (/^(?:[£$€¥]\s*)?\d{1,6}[.,]\d{2}(?:\s*(?:GBP|EUR|USD|CNY|RMB))?$/i.test(code) || /^[£$€¥]/.test(code))
    return {code: null, issue: 'The product code looks like a price (' + raw + ').', rejected: true};
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(compact) && (validCalendarDate(compact.replace(/[/.]/g, '-')) ||
      /^(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.]\d{2,4}$/.test(compact) || /^(?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.]\d{2,4}$/.test(compact)))
    return {code: null, issue: 'The product code looks like a date (' + raw + ').', rejected: true};
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(compact))
    return {code: null, issue: 'The product code looks like a time (' + raw + ').', rejected: true};
  const dates = compactDate(compact);
  if (dates.length && date && dates.includes(date))
    return {code: null, issue: 'The product code matches the purchase date (' + raw + ').', rejected: true};
  if (dates.length && compact.length === 8)
    return isGtin(compact)
      ? {code, issue: 'The product code could also be read as a date (' + raw + '). Check the printed code.', rejected: false}
      : {code: null, issue: 'The product code looks like a date (' + raw + ').', rejected: true};
  if (card && /^\d{4}$/.test(compact) && compact === digitsOf(card).slice(-4))
    return {code: null, issue: 'The product code matches the card and was cleared.', rejected: true};
  if (phone && digitsOf(phone).length >= 7 && digitsOf(code) === digitsOf(phone))
    return {code: null, issue: 'The product code is the store telephone number (' + raw + ').', rejected: true};
  if (/^\+\d/.test(code) || /^\(?0\d{2,4}\)?[\s-]\d{3,4}[\s-]?\d{3,4}$/.test(code))
    return {code: null, issue: 'The product code looks like a telephone number (' + raw + ').', rejected: true};
  if (/^0[1-9]\d{8,9}$/.test(compact) && !isGtin(compact))
    issue ||= 'The product code has the shape of a telephone number. Check the printed code.';
  return {code, issue, rejected: false};
}

// ---------------------------------------------------------------------------
// 品名 sanity: summary words, column headings and bare numbers are never item names.
const nonItemWords = /^(?:amount|amt|total|grand\s+total|sub\s*-?\s*total|subtotal|vat|tax|tva|mwst|gst|change|balance(?:\s+due)?|cash|card|payment|tender|discount|qty|quantity|price|unit\s+price|item|items|description|desc|sum|summe|net|gross|due|paid|rounding|tip|service(?:\s+charge)?|n\/?a|null|none|unknown)$/i;
export function nonItemName(value) {
  const text = clean(value).replace(/[\s:#*.=-]+$/g, '').replace(/^[\s:#*.=-]+/g, '');
  if (!text) return null;
  if (/^[\d\s.,'£$€¥%#*+-]+$/.test(text)) return 'The item name is only a number (' + clean(value) + ').';
  const words = text.replace(/[\s:]+(?:GBP|EUR|USD|[£$€])?\s*[\d.,]+\s*%?$/i, '').replace(/[\s:#*.=-]+$/g, '');
  if (nonItemWords.test(words)) return 'The item name is a receipt label, not a product (' + clean(value) + ').';
  return null;
}

// ---------------------------------------------------------------------------
// Store clues: printed address, postcode, store number and phone. Only copied
// from the header and footer text; never inferred and never appended to 供应商.
const ukPostcode = /\b(GIR\s?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\s?\d[ABD-HJLNP-UW-Z]{2})\b/;
const ukAreas = new Set('AB AL B BA BB BD BH BL BN BR BS BT CA CB CF CH CM CO CR CT CV CW DA DD DE DG DH DL DN DT DY E EC EH EN EX FK FY G GL GU HA HD HG HP HR HS HU HX IG IP IV KA KT KW KY L LA LD LE LL LN LS LU M ME MK ML N NE NG NN NP NR NW OL OX PA PE PH PL PO PR RG RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TD TF TN TQ TR TS TW UB W WA WC WD WF WN WR WS WV YO ZE'.split(' '));
function validOutward(outward) {
  const compact = String(outward || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{1,2}\d[A-Z\d]?$/.test(compact)) return false;
  return ukAreas.has(compact.match(/^[A-Z]{1,2}/)[0]);
}
// SH1X is the usual OCR of SW1X. Correct H→W only when the result is a real district; otherwise keep the printed text.
function readUkPostcode(text) {
  const upper = String(text || '').toUpperCase();
  const match = upper.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[ABD-HJLNP-UW-Z]{2})\b/);
  if (!match) return null;
  const raw = text.slice(match.index, match.index + match[0].length).replace(/\s+/g, ' ').trim();
  if (validOutward(match[1])) return match[1] + ' ' + match[2];
  if (match[1].length >= 2 && match[1][1] === 'H') {
    const fixed = match[1][0] + 'W' + match[1].slice(2);
    if (validOutward(fixed)) return fixed + ' ' + match[2];
  }
  return raw;
}
function londonPhone(text) {
  // 020 plus exactly eight digits. Spaces and dots are allowed; a short or split fragment is not a phone.
  const match = text.match(/\b(0[\s.]*2[\s.]*0(?:[\s.]*\d){8})(?![\s.]*\d)/);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, '');
  return digits === '020' + digits.slice(3) && digits.length === 11 ? match[1].replace(/\s+/g, ' ').replace(/\.+/g, ' ').trim() : null;
}
function extractPhone(text) {
  const london = londonPhone(text);
  if (london) return london;
  const spaced = text.match(/\b((?:\+44\s?(?:\(0\)\s?)?|0)\d{2,4}(?:[\s-]\d{3,4}){1,3})\b/);
  const generic = text.match(/(?:\b(?:tel|phone|telephone|tél|téléphone|telefon)\.?\s*(?:no\.?)?\s*[:.]?\s*)?(\+?\(?\d[\d\s().-]{6,}\d)/i);
  const raw = ((spaced && spaced[1]) || (generic && generic[1]) || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  // A truncated London number, or a short 07 fragment, is not a phone.
  if (digits.startsWith('020') && digits.length !== 11) return null;
  if (digits.startsWith('07') && digits.length !== 11) return null;
  return raw;
}
const usZip = /\b[A-Z]{2}\s+(\d{5}(?:-\d{4})?)\b/;
const euPostcode = /^(?:[A-Z]-)?(\d{4,5})\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'’ -]{2,}$/;
const streetWords = /\b(?:road|rd|street|st|avenue|ave|lane|ln|drive|dr|square|sq|place|pl|terrace|way|row|court|ct|crescent|close|gardens|park|walk|wharf|centre|center|mall|plaza|parade|broadway|blvd|boulevard|highway|hwy|rue|avenue|place|chemin|bd|allée|strasse|straße|platz|weg|via|calle|plaza|jalan|jl|unit|level|floor|building|bldg|suite)\b\.?/i;
const phonePattern = /(?:\b(?:tel|phone|telephone|tél|téléphone|telefon)\.?\s*(?:no\.?)?\s*[:.]?\s*)?(\+?\(?\d[\d\s().-]{6,}\d)/i;
const storeNumberPattern = /\b(?:store|shop|branch|boutique|magasin|site|filiale|location|loc)\s*(?:no\.?|number|nr\.?|n[°º]|#|id)?\s*[:#]?\s*([A-Z]?\d{1,8})\b/i;
const headerStop = /\b(?:qty|quantity|description|item|article|price|amount|sale|vente|receipt\s*(?:no|number)|order\s*(?:id|no|number)|transaction|date|time|cashier|caissier|subtotal|total)\b|\d+[.,]\d{2}\b/i;

// UK day-month dates apply to Harrods, N.Peal, Selfridges, or a receipt whose
// store clues show a UK address, a UK postcode, +44, or a 020 phone.
export function isUkPurchase(merchant, storeClues) {
  const name = String(merchant || '');
  if (/\bharrods\b/i.test(name) || /\bselfridges\b/i.test(name) || /\bn\.?\s*peal\b/i.test(name)) return true;
  const clues = storeClues && typeof storeClues === 'object' ? storeClues : {};
  if (readUkPostcode(String(clues.postcode || ''))) return true;
  const phone = String(clues.phone || '');
  const digits = phone.replace(/\D/g, '');
  if (/\+44\b/.test(phone) || digits.startsWith('44') || digits.startsWith('020')) return true;
  const address = [].concat(clues.addressLines || []).join('\n');
  if (/\b(?:united kingdom|uniled kingdom|united kingdon|england|scotland|wales|great britain|london)\b/i.test(address)) return true;
  return Boolean(readUkPostcode(address));
}

export function readStoreClues(lines, merchant = null) {
  const texts = (lines || []).map(l => clean(typeof l === 'string' ? l : l?.text)).filter(Boolean);
  const clues = {addressLines: [], postcode: null, storeNumber: null, phone: null};
  if (!texts.length) return clues;
  const firstBody = texts.findIndex((t, i) => i > 0 && headerStop.test(t));
  const header = texts.slice(0, firstBody < 0 ? Math.min(8, texts.length) : Math.min(firstBody + 1, 10));
  const lastTotal = texts.findLastIndex(t => /\b(?:total|balance\s+due|net\s+[àa]\s+payer)\b/i.test(t));
  const footer = lastTotal >= 0 ? texts.slice(lastTotal + 1) : [];
  const merchantKey = loose(merchant);
  for (const text of [...header, ...footer]) {
    if (!clues.storeNumber) clues.storeNumber = storeNumberPattern.exec(text)?.[1] ?? null;
    const phoneText = extractPhone(text);
    const phoneDigits = phoneText ? digitsOf(phoneText) : '';
    const labelledPhone = /\b(?:tel|phone|telephone|tél|téléphone|telefon)\b/i.test(text);
    const tillDigits = (text.match(/\d{4}-\d{6}/) || [''])[0].replace(/\D/g, '');
    const fusedTill = phoneDigits.length === 13 && !/\s/.test(phoneText || '')
      || (tillDigits.length === 10 && phoneDigits.includes(tillDigits));
    // A Harrods till number, or a 13-digit run fused from one, is not a telephone.
    // A spaced UK number such as 020 7730 1234 is kept in full.
    const phoneShaped = phoneText && phoneDigits.length >= 9 && phoneDigits.length <= 13 && !fusedTill &&
      (labelledPhone || /^\s*(?:\+|\(?0)\d/.test(phoneText)) && !/\d[.,]\d{2}\b/.test(text) &&
      !/^\d{4}-\d{6}$/.test(phoneText.replace(/\s+/g, '')) && !/\bNT[0O1]\d/i.test(text);
    if (!clues.phone && phoneShaped) clues.phone = phoneText;
    const uk = readUkPostcode(text), us = usZip.exec(text), eu = euPostcode.exec(text.trim());
    const postcode = uk || us?.[1] || eu?.[1] || null;
    if (!clues.postcode && postcode && !headerStop.test(text.replace(ukPostcode, ''))) clues.postcode = postcode;
    const policyLine = /\b(?:return|refund|policy|exchange|warranty|served|appointment|please|goods|customer)\b/i.test(text);
    const shortStreetOnly = /\b(?:pl|ln|st|rd|ct|dr|sq)\b/i.test(text) && !/\b(?:road|street|avenue|lane|drive|square|place|terrace|way|court|crescent|close|gardens|park|walk|wharf|centre|center|mall|plaza|parade|broadway|boulevard|highway|strasse|straße|platz|chemin|calle)\b/i.test(text);
    const address = !policyLine && ((postcode && !headerStop.test(text)) ||
      (streetWords.test(text) && !shortStreetOnly && /\d|\b[A-Z][a-z]+\b/.test(text) && !headerStop.test(text) && text.length <= 60) ||
      (shortStreetOnly && /\d/.test(text) && /\b[A-Z][a-z]{2,}\s+(?:pl|ln|st|rd|ct|dr|sq)\b/.test(text) && text.length <= 60));
    if (address && loose(text) !== merchantKey && !(phoneShaped && digitsOf(text) === phoneDigits) && !clues.addressLines.includes(text))
      clues.addressLines.push(text);
  }
  return clues;
}

// Fill only the store-clue fields the model left empty. Never replace a printed
// value the model already returned, and never invent a branch on the merchant.
export function mergeStoreClues(existing, printed) {
  const clues = existing && typeof existing === 'object' ? existing : {};
  const text = value => { const cleaned = String(value ?? '').trim(); return cleaned || null; };
  const addressLines = Array.isArray(clues.addressLines) ? clues.addressLines.map(text).filter(Boolean) : [];
  const fromPrint = printed && typeof printed === 'object' ? printed : {addressLines:[], postcode:null, storeNumber:null, phone:null};
  return {
    addressLines: addressLines.length ? addressLines : (Array.isArray(fromPrint.addressLines) ? fromPrint.addressLines : []),
    postcode: text(clues.postcode) || fromPrint.postcode || null,
    storeNumber: text(clues.storeNumber) || fromPrint.storeNumber || null,
    phone: text(clues.phone) || fromPrint.phone || null,
  };
}

// ---------------------------------------------------------------------------
// 采购小票id store layouts. Geometry is normalised (0–1) to the upright photo.
const hasBox = b => b && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(b[k])) && b.w > 0 && b.h > 0;
const idShape = /^(?=[A-Z\d/-]*\d)[A-Z\d][A-Z\d/-]{3,29}$/i;
const dateToken = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/;
const clockToken = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const barGlyphs = /[|Il1!\[\](){}\/\\]/g;
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
function words(line) {
  return line.words?.length ? line.words : [{...line}];
}
// A barcode reads as a band of bar glyphs, or as a very tall low-confidence row.
export function isBarcodeLine(line, typicalHeight = 0) {
  const text = clean(line?.text).replace(/\s+/g, '');
  if (text.length >= 6 && (text.match(barGlyphs) || []).length / text.length >= .6) return true;
  return hasBox(line) && typicalHeight > 0 && line.h >= 2.6 * typicalHeight && Number(line.confidence) < .6 && !/\p{L}{3}/u.test(clean(line.text));
}
function idFrom(line) {
  return words(line).map(w => ({...w, token: clean(w.text).replace(/^[#:]+|[,;:]+$/g, '')}))
    .filter(w => idShape.test(w.token) && !dateToken.test(w.token) && !clockToken.test(w.token) && !/^\d+[.,]\d{2}$/.test(w.token));
}

// Returns {rule, status:'found'|'unclear'|'missing', value, evidence, certainty, reason} or null
// when the retailer has no store-specific 采购小票id rule.
export function storeReceiptId(merchant, ocr) {
  const shop = loose(merchant);
  const rule = shop.includes('selfridges') ? 'selfridges-below-barcode' : shop.includes('harrods') ? 'harrods-right-of-date-time' : null;
  if (!rule) return null;
  const lines = (ocr?.lines || []).filter(l => clean(l.text));
  const missing = reason => ({rule, status: 'missing', value: null, evidence: '', certainty: 0, reason});
  if (!lines.length) return missing('No OCR lines were available to locate the store receipt number.');
  const typical = median(lines.map(l => l.h));
  if (rule === 'selfridges-below-barcode') {
    const bars = lines.map((l, i) => isBarcodeLine(l, typical) ? i : -1).filter(i => i >= 0);
    if (!bars.length) return missing('Selfridges receipt number: no barcode was found on the photo.');
    for (const b of bars.reverse()) {
      const bar = lines[b];
      // The receipt number is the first text row directly below the barcode band.
      const below = lines.slice(b + 1).find(l => !isBarcodeLine(l, typical));
      if (!below) continue;
      const gap = hasBox(bar) && hasBox(below) ? below.y - bar.y - bar.h : 0;
      if (gap > Math.max(.06, 3 * (typical || .02))) continue;
      const ids = idFrom(below);
      if (ids.length === 1) {
        const certainty = Number(ids[0].confidence ?? below.confidence) || 0;
        return {rule, status: certainty >= .8 ? 'found' : 'unclear', value: ids[0].token, evidence: below.text, certainty,
          reason: certainty >= .8 ? 'Selfridges: the receipt number printed directly below the barcode.' : 'Selfridges: the number below the barcode is not clearly legible.'};
      }
      if (ids.length > 1) return {rule, status: 'unclear', value: ids[0].token, evidence: below.text, certainty: 0,
        reason: 'Selfridges: several codes are printed below the barcode.'};
    }
    return missing('Selfridges: no receipt number was found directly below the barcode.');
  }
  // Harrods: the number to the right of the date and time on the same printed row.
  for (const line of lines) {
    const ws = words(line);
    const dateAt = ws.findIndex(w => dateToken.test(clean(w.text)));
    const timeAt = ws.findIndex(w => clockToken.test(clean(w.text).replace(/[ap]m$/i, '')));
    if (dateAt < 0 || timeAt < 0) continue;
    const anchor = ws[Math.max(dateAt, timeAt)];
    const right = idFrom({...line, words: ws.slice(Math.max(dateAt, timeAt) + 1)})
      .filter(w => !hasBox(w) || !hasBox(anchor) || w.x >= anchor.x + anchor.w - .001);
    if (right.length === 1) {
      const raw = right[0].token.toUpperCase();
      const shape = /^NT\d{4}-\d{6}$/;
      const ntFamily = /^(?:NT|NR|N7|NTO|N10)/.test(raw);
      const repaired = raw.replace(/^NR/, 'NT').replace(/^N7/, 'NT').replace(/^NTO/, 'NT0').replace(/^N10/, 'NT0');
      const alternatives = [];
      if (repaired !== raw) alternatives.push(repaired);
      const laterDigits = lines.slice(lines.indexOf(line) + 1)
        .map(row => String(row.text || '').trim())
        .filter(row => /^\d[\d\s-]{9,}$/.test(row))
        .map(row => row.replace(/\D/g, ''))
        .filter(digits => digits.length >= 10 && digits.length <= 16);
      const ownDigits = raw.replace(/\D/g, '');
      const barcodeDisagrees = laterDigits.length > 0 && laterDigits.every(digits => digits !== ownDigits);
      for (const digits of laterDigits) if (digits !== ownDigits && !alternatives.includes(digits)) alternatives.push(digits);
      const certainty = Number(right[0].confidence ?? line.confidence) || 0;
      if (ntFamily) {
        const clear = shape.test(raw) && !barcodeDisagrees && certainty >= .8;
        return {rule, status: clear ? 'found' : 'unclear', value: raw, alternatives, evidence: line.text, certainty,
          reason: clear ? 'Harrods: the receipt number to the right of the date and time.' : 'Harrods: the receipt number is not exactly NT and four digits, a hyphen, and six digits. The printed reading is kept.'};
      }
      const clear = !barcodeDisagrees && certainty >= .8;
      return {rule, status: clear ? 'found' : 'unclear', value: raw, alternatives, evidence: line.text, certainty,
        reason: clear ? 'Harrods: the receipt number to the right of the date and time.' : 'Harrods: the number beside the date and time is not clearly legible.'};
    }
    if (right.length > 1) return {rule, status: 'unclear', value: right.at(-1).token, evidence: line.text, certainty: 0,
      reason: 'Harrods: several codes are printed to the right of the date and time.'};
  }
  return missing('Harrods: no receipt number was found to the right of the date and time.');
}

// A store-rule id, including an unclear NT0 normalisation, is owned by that rule.
// A generic ambiguous suggestion must not clear it. The pink flag still comes from the rule.
export function confirmedStoreReceiptId(merchant, ocr, value) {
  const storeId = storeReceiptId(merchant, ocr);
  if (!storeId?.value || (storeId.status !== 'found' && storeId.status !== 'unclear')) return false;
  return String(value ?? '').trim().toLowerCase() === String(storeId.value).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// True-zero vs OCR-miss. A zero-price line is excluded only when a clear printed
// 0.00 sits on the product's own row and the receipt still reconciles with it.
const zeroToken = /(?<![\d.,])0[.,]00(?![\d])|\b(?:free|gratuit|offert|gratis|complimentary|n\/c|no\s+charge)\b/i;
const zeroReasons = /\b(?:bag|carrier|gift\s*wrap|wrapping|sample|tester|free|complimentary|gratuit|offert|carriage|shipping|delivery|promo|gift|packaging|box|service|experience|consultation|appointment)\b/i;
const isZero = v => v != null && Number(v) === 0;
const near = (a, b) => Math.abs(a - b) <= .02;
function receiptBalances(data) {
  const total = Number(data.total);
  if (data.total == null || !Number.isFinite(total)) return false;
  // A total with no product lines is not a reconciliation.
  if (!data.items?.length) return false;
  const amounts = (data.items || []).map(i => i.amount);
  if (amounts.some(a => a == null || !Number.isFinite(Number(a)))) return false;
  const sum = amounts.reduce((t, a) => t + Number(a), 0);
  const discount = Number(data.receiptDiscount ?? data.discount) || 0, tax = Number(data.tax);
  return [sum, sum - discount, ...(Number.isFinite(tax) ? [sum + tax, sum - discount + tax] : [])].some(v => near(v, total));
}
function productLineFor(item, lines) {
  const want = loose(item.item);
  const codes = [item.itemId, item.sku].map(loose).filter(Boolean);
  if (!want && !codes.length) return [];
  return lines.filter(l => {
    const t = loose(l.text);
    return (want.length >= 3 && t.includes(want)) || codes.some(c => c.length >= 4 && t.includes(c));
  });
}

// Classify one zero-price row: 'true-zero', 'doubtful' or null (not a zero row).
export function classifyZeroPrice(item, data, ocr) {
  if (!(isZero(item.amount) || (item.amount == null && isZero(item.unitPrice)))) return null;
  const lines = ocr?.lines || [];
  const rows = productLineFor(item, lines);
  const index = rows.length === 1 ? lines.indexOf(rows[0]) : -1;
  // The zero may sit on the product row or on its detail row directly below.
  const nearby = index < 0 ? [] : [lines[index], lines[index + 1]].filter(Boolean);
  const printed = nearby.map(l => {
    const m = zeroToken.exec(l.text);
    if (!m) return null;
    const word = (l.words || []).find(w => zeroToken.test(w.text));
    return {line: l, confidence: Number(word?.confidence ?? l.confidence) || 0};
  }).find(Boolean);
  const reasons = [];
  if (rows.length !== 1) reasons.push(rows.length ? 'the product appears on several rows' : 'the product row could not be located on the photo');
  if (!printed) reasons.push('no printed 0.00 was found on the product row');
  else if (printed.confidence < .85) reasons.push('the printed zero is not clearly legible');
  if (!receiptBalances(data)) reasons.push('the line amounts do not reconcile with the receipt total');
  if (item.qty != null && item.unitPrice != null && !isZero(Number(item.qty) * Number(item.unitPrice))) reasons.push('quantity × unit price is not zero');
  if (reasons.length) return {status: 'doubtful', reason: 'This 0.00 price may be an OCR miss: ' + reasons.join('; ') + '.', evidence: rows.map(r => r.text).join(' | ')};
  const kind = zeroReasons.exec([item.item, printed.line.text].join(' '))?.[0] || 'printed zero';
  return {status: 'true-zero', reason: 'Printed 0.00 confirmed on the product row (' + kind.toLowerCase() + ') and the receipt total reconciles.', evidence: printed.line.text};
}

// Move confirmed true-zero rows into `excludedZeroItems`; doubtful zeros stay with a
// reading issue so that checks.js flags them Pink.
export function applyZeroPriceExclusion(data, ocr) {
  if (!data?.items?.length) return data;
  const kept = [], excluded = [...(data.excludedZeroItems || [])], issues = [...(data.fieldIssues || [])];
  const verdicts = data.items.map(item => classifyZeroPrice(item, data, ocr));
  for (const [i, item] of data.items.entries()) {
    const verdict = verdicts[i];
    if (verdict?.status === 'true-zero') { excluded.push({item: {...item}, reason: verdict.reason, evidence: verdict.evidence}); continue; }
    kept.push(item);
  }
  kept.forEach((item, i) => {
    const original = data.items.indexOf(item);
    const verdict = verdicts[original];
    if (verdict?.status === 'doubtful')
      issues.push({field: 'items.' + i + '.amount', reason: 'doubtful_zero_price', evidence: verdict.reason + (verdict.evidence ? ' ' + verdict.evidence : '')});
  });
  // Keep index-based issues aligned with the remaining rows.
  const remap = new Map(kept.map((item, i) => [data.items.indexOf(item), i]));
  const aligned = issues.map(issue => {
    const m = /^items\.(\d+)\.(.+)$/.exec(issue.field || '');
    if (!m || issue.reason === 'doubtful_zero_price') return issue;
    const to = remap.get(Number(m[1]));
    return to == null ? null : {...issue, field: 'items.' + to + '.' + m[2]};
  }).filter(Boolean);
  return {...data, items: kept, excludedZeroItems: excluded, fieldIssues: aligned};
}
