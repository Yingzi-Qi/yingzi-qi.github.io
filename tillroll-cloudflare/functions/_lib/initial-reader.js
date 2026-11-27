// Deterministic first-reader contract and catalogue matcher.
// OCR may provide the input, but this module never calls an OCR or LLM service.
import { canonicalBrand } from './brands.js';

const FUNDAMENTAL_CONFIDENCE = 0.75;
const REVIEW = 'Pink';
const AMBER = 'Amber';
const ALLOWED_TENDERS = new Set(['UnionPay', 'Card', 'Alipay', 'WeChat']);
const str = value => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim());

function rawValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value.value ?? value.text ?? value.raw ?? value.normalized ?? null;
  }
  return value;
}

function confidenceOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const n = Number(value.confidence);
  return Number.isFinite(n) ? n : null;
}

function ambiguous(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value.ambiguous === true || value.conflict === true));
}

function numeric(value) {
  const raw = rawValue(value);
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = String(raw).replace(/[£$€\s]/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function positiveAmount(value) {
  const n = numeric(value);
  return n !== null && n > 0 ? Math.round(n * 100) / 100 : null;
}

function dateValue(value) {
  const s = str(rawValue(value));
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const stamp = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === s ? s : null;
}

function timeValue(value) {
  const s = str(rawValue(value));
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]), sec = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59 || sec > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function flag(field, reason, severity = REVIEW, extra = {}) {
  return { field, reason, severity, ...extra };
}

function readFundamental(value, field, parse, missingReason, invalidReason) {
  const parsed = parse(value);
  const confidence = confidenceOf(value);
  if (parsed === null) {
    return { value: null, confidence, flags: [flag(field, rawValue(value) ? invalidReason : missingReason)] };
  }
  if (ambiguous(value) || (confidence !== null && confidence < FUNDAMENTAL_CONFIDENCE)) {
    return { value: null, confidence, flags: [flag(field, 'OCR reading is ambiguous or below the fundamental-field confidence threshold.')] };
  }
  return { value: parsed, confidence, flags: [] };
}

function readOptional(value) {
  return str(rawValue(value));
}

function readTender(value) {
  const raw = rawValue(value);
  const text = str(raw);
  const normalised = !text ? null
    : /union\s*pay|银联/i.test(text) ? 'UnionPay'
      : /ali\s*pay/i.test(text) ? 'Alipay'
        : /we\s*chat|wechat/i.test(text) ? 'WeChat'
          : /visa|mastercard|master\s*card|maestro|amex|american express|carte\s*(?:bleue|bancaire)|debit|credit|card|apple\s*pay|google\s*pay|samsung\s*pay|garmin\s*pay|android\s*pay|wallet/i.test(text) ? 'Card'
            : text;
  const confidence = confidenceOf(value);
  if (!normalised) return { value: null, confidence, flags: [flag('paymentMethod', 'Payment method is missing.')] };
  if (ambiguous(value) || (confidence !== null && confidence < FUNDAMENTAL_CONFIDENCE)) {
    return { value: null, confidence, flags: [flag('paymentMethod', 'OCR reading is ambiguous or below the fundamental-field confidence threshold.')] };
  }
  if (!ALLOWED_TENDERS.has(normalised)) return { value: null, confidence, flags: [flag('paymentMethod', `Unsupported payment method: ${normalised}.`)] };
  return { value: normalised, confidence, flags: [] };
}

function paymentEntries(input) {
  const candidates = input.payments ?? input.tenders ?? input.paymentMethods;
  if (Array.isArray(candidates)) return candidates.filter(item => rawValue(item) !== null && str(rawValue(item)));
  if (typeof candidates === 'string' && /[,/;+]|\band\b/i.test(candidates)) return candidates.split(/[,/;+]|\band\b/i).map(value => value.trim()).filter(Boolean);
  return [];
}

function fieldFrom(item, names) {
  for (const name of names) if (item && item[name] !== undefined && item[name] !== null && rawValue(item[name]) !== '') return item[name];
  return null;
}

function readItem(item, index) {
  const source = item && typeof item === 'object' ? item : {};
  const quantityRaw = fieldFrom(source, ['quantity', 'qty']) ?? 1;
  const quantity = Math.max(1, Math.floor(numeric(quantityRaw) || 1));
  const itemPriceRaw = fieldFrom(source, ['itemPrice', 'originalPrice', 'unitPrice', 'price']);
  const purchasePriceRaw = fieldFrom(source, ['purchasePrice', 'paidAmount', 'finalPrice', 'amount', 'price']);
  let itemPrice = positiveAmount(itemPriceRaw);
  let purchasePrice = positiveAmount(purchasePriceRaw);
  const flags = [];
  if (itemPrice === null) flags.push(flag(`items[${index}].itemPrice`, rawValue(itemPriceRaw) ? 'Item price is invalid or not positive.' : 'Item price is missing.'));
  else if (ambiguous(itemPriceRaw) || (confidenceOf(itemPriceRaw) !== null && confidenceOf(itemPriceRaw) < FUNDAMENTAL_CONFIDENCE)) { itemPrice = null; flags.push(flag(`items[${index}].itemPrice`, 'OCR reading is ambiguous or below the fundamental-field confidence threshold.')); }
  if (purchasePrice === null) flags.push(flag(`items[${index}].purchasePrice`, rawValue(purchasePriceRaw) ? 'Paid purchase amount is invalid or not positive.' : 'Paid purchase amount is missing.'));
  else if (ambiguous(purchasePriceRaw) || (confidenceOf(purchasePriceRaw) !== null && confidenceOf(purchasePriceRaw) < FUNDAMENTAL_CONFIDENCE)) { purchasePrice = null; flags.push(flag(`items[${index}].purchasePrice`, 'OCR reading is ambiguous or below the fundamental-field confidence threshold.')); }
  const brand = readOptional(fieldFrom(source, ['brand', 'brandName']));
  const name = readOptional(fieldFrom(source, ['name', 'description', 'productName']));
  const reference = readOptional(fieldFrom(source, ['reference', 'ref', 'itemId', 'productId', 'sku']));
  if (!brand && !name && !reference) flags.push(flag(`items[${index}].clue`, 'No brand, item name, or reference was read for this priced line.', AMBER, { code: 'missing_item_clue' }));
  if (itemPrice !== null && purchasePrice !== null && purchasePrice > itemPrice + 0.005) flags.push(flag(`items[${index}].purchasePrice`, 'Paid purchase amount is greater than the printed item price.'));
  return {
    index,
    quantity,
    itemPrice,
    purchasePrice,
    brand,
    name,
    reference,
    flags,
  };
}

export function normaliseInitialReceipt(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const flags = [];
  const receiptId = readFundamental(source.receiptId ?? source.receipt_id, 'receiptId', value => str(rawValue(value)), 'Receipt ID is missing.', 'Receipt ID is invalid.');
  const date = readFundamental(source.date ?? source.purchaseDate, 'date', dateValue, 'Purchase date is missing.', 'Purchase date must be a valid YYYY-MM-DD date.');
  const time = readFundamental(source.time ?? source.purchaseTime, 'time', timeValue, 'Purchase time is missing.', 'Purchase time must be HH:MM or HH:MM:SS.');
  const tender = readTender(source.paymentMethod ?? source.tender);
  flags.push(...receiptId.flags, ...date.flags, ...time.flags, ...tender.flags);
  const entries = paymentEntries(source);
  if (entries.length > 1) flags.push(flag('paymentMethod', 'A single receipt total is split across multiple tender entries.', REVIEW, { code: 'split_payment' }));
  const itemsInput = Array.isArray(source.items) ? source.items : [];
  const items = itemsInput.map(readItem);
  flags.push(...items.flatMap(item => item.flags));
  if (!items.length) flags.push(flag('items', 'No item line with a positive price and an item clue was supplied.'));
  const totalRaw = source.totalPaid ?? source.paidTotal ?? source.total;
  const totalPaid = positiveAmount(totalRaw);
  if (totalPaid === null) flags.push(flag('totalPaid', rawValue(totalRaw) ? 'Receipt total is invalid or not positive.' : 'Receipt total is missing.', AMBER));
  const evidence = source.evidence && typeof source.evidence === 'object' ? { ...source.evidence } : {};
  const reviewRequired = flags.length > 0;
  return {
    receiptId: receiptId.value,
    date: date.value,
    time: time.value,
    paymentMethod: tender.value,
    totalPaid,
    items,
    flags,
    reviewRequired,
    evidence: {
      source: str(evidence.source) || 'unknown',
      rawText: str(evidence.rawText),
      imageHash: str(source.imageHash ?? evidence.imageHash),
      imageUrl: str(source.imageUrl ?? evidence.imageUrl),
    },
  };
}

function compact(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokens(value) {
  return new Set(String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1));
}

function cents(value) {
  const n = numeric(value);
  return n === null ? null : Math.round(n * 100);
}

function candidatePriceCents(candidate) {
  if (candidate.price !== undefined && candidate.price !== null) return cents(candidate.price);
  if (candidate.pricePence !== undefined && candidate.pricePence !== null) return Math.round(Number(candidate.pricePence));
  return null;
}

// D1 returns the catalogue columns with their snake_case names. Keeping this
// adapter at the matcher boundary lets the pure matcher accept either the
// database shape or a camelCase fixture without changing the acceptance rule.
function normaliseCatalogueCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  return {
    ...candidate,
    brand: candidate.brand ?? candidate.brand_name,
    itemId: candidate.itemId ?? candidate.item_id,
    officialName: candidate.officialName ?? candidate.official_name,
    pricePence: candidate.pricePence ?? candidate.price_pence,
    sourceUrl: candidate.sourceUrl ?? candidate.source_url,
    weightGrams: candidate.weightGrams ?? candidate.weight_grams,
  };
}

function clueScore(item, candidate) {
  const reference = item.reference && candidate.itemId && compact(item.reference) === compact(candidate.itemId) ? 60 : 0;
  const brand = item.brand && candidate.brand && canonicalBrand(item.brand) === canonicalBrand(candidate.brand) ? 25 : 0;
  const a = tokens(item.name), b = tokens(candidate.officialName);
  const shared = a.size ? [...a].filter(token => b.has(token)).length / a.size : 0;
  const name = shared >= 0.5 ? 15 : 0;
  return { score: reference + brand + name, clues: [reference ? 'reference' : null, brand ? 'brand' : null, name ? 'name' : null].filter(Boolean) };
}

function candidateOutput(candidate, item, exact, now) {
  const clues = clueScore(item, candidate);
  const priceCents = candidatePriceCents(candidate);
  return {
    brand: str(candidate.brand),
    name: str(candidate.officialName ?? candidate.name),
    reference: str(candidate.itemId ?? candidate.reference),
    price: priceCents === null ? null : priceCents / 100,
    currency: str(candidate.currency)?.toUpperCase() || 'GBP',
    sourceUrl: str(candidate.sourceUrl ?? candidate.source_url ?? candidate.url),
    retrievedAt: now,
    clues: clues.clues,
    clueScore: clues.score,
    exactPrice: exact,
  };
}

function fallbackSort(item, candidates) {
  const price = cents(item.itemPrice);
  const withClues = candidates.map((candidate, index) => {
    const candidateCents = candidatePriceCents(candidate);
    const clues = clueScore(item, candidate);
    const gap = price === null || candidateCents === null ? Infinity : Math.abs(candidateCents - price);
    const below = candidateCents !== null && price !== null && candidateCents < price;
    const weight = Number(candidate.weightGrams);
    return { candidate, index, clues: clues.score, gap, below, weight: Number.isFinite(weight) ? weight : Infinity };
  });
  const cluePool = withClues.some(row => row.clues > 0) ? withClues.filter(row => row.clues > 0) : withClues;
  cluePool.sort((a, b) => Number(a.below) - Number(b.below) || a.gap - b.gap || a.weight - b.weight || a.index - b.index);
  return cluePool;
}

export function matchInitialItem(item, catalogue = [], now = new Date().toISOString()) {
  const candidates = Array.isArray(catalogue) ? catalogue.map(normaliseCatalogueCandidate).filter(Boolean) : [];
  const price = cents(item?.itemPrice);
  const exactRows = candidates.filter(candidate => {
    const candidatePrice = candidatePriceCents(candidate);
    const currency = str(candidate.currency)?.toUpperCase() || 'GBP';
    return price !== null && candidatePrice === price && (!item.currency || currency === String(item.currency).toUpperCase());
  });
  const exactScored = exactRows.map(candidate => ({ candidate, ...clueScore(item, candidate) })).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
  if (exactScored.length && (exactScored.length === 1 || exactScored[0].score > exactScored[1].score)) {
    const officialMatch = candidateOutput(exactScored[0].candidate, item, true, now);
    return { status: 'accepted', matchType: 'exact-price-clue', officialMatch, candidates: exactRows.map(candidate => candidateOutput(candidate, item, true, now)), reason: null };
  }
  if (exactScored.length) {
    return { status: 'review', matchType: 'exact-price-tie', officialMatch: null, candidates: exactRows.map(candidate => candidateOutput(candidate, item, true, now)), reason: 'More than one exact-price catalogue row has the same best clue score.' };
  }
  if (!candidates.length) return { status: 'no_match', matchType: 'none', officialMatch: null, candidates: [], reason: 'No catalogue candidates were found.' };
  const fallback = fallbackSort(item, candidates);
  const evidence = fallback.slice(0, 10).map(row => candidateOutput(row.candidate, item, false, now));
  return { status: 'review', matchType: 'nearest-price-review', officialMatch: null, candidates: evidence, reason: 'No exact catalogue price and clue match was found. Nearest candidate is review evidence only.' };
}

export function matchInitialReceipt(reading, catalogueByItem = []) {
  const items = Array.isArray(reading?.items) ? reading.items : [];
  const matches = items.map(item => matchInitialItem(item, catalogueByItem[item.index] || [], new Date().toISOString()));
  const reviewFlags = matches.flatMap((match, index) => match.status === 'accepted' ? [] : [flag(`items[${index}].catalogue`, match.reason, AMBER, { code: match.matchType })]);
  return { matches, reviewFlags, reviewRequired: Boolean(reading?.reviewRequired || reviewFlags.length) };
}

export { FUNDAMENTAL_CONFIDENCE };
