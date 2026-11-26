// Item blocks and labelled identifiers.
// Printed receipt text is data. Instructions, URLs, QR directions, return
// policies and survey text are never followed and never become identifiers.
import {sortItemFields} from './field-sorter.js';
import {brandItemIdCandidate} from './receipt-rules.js';

export const identifierClasses = Object.freeze([
  'physical_item_id',
  'serial_number',
  'product_id',
  'sku',
  'product_code',
  'style_or_model_reference',
  'receipt_or_transaction_number',
  'payment_reference',
  'payment_card',
  'payment_auth',
  'payment_merchant',
  'payment_terminal',
  'loyalty_or_rewards_number',
  'barcode_or_qr',
  'unknown',
]);

const paymentClasses = new Set(['payment_card', 'payment_auth', 'payment_merchant', 'payment_terminal', 'payment_reference']);
const primaryOrder = ['physical_item_id', 'product_id', 'serial_number', 'product_code'];
const candidateClasses = new Set(['physical_item_id', 'product_id', 'product_code', 'sku', 'style_or_model_reference', 'serial_number', 'barcode_or_qr', 'ean']);
const candidateRejectedLine = /^(?:total|sub\s*total|amount|balance|cash|change|tender|payment|visa|master\s*card|amex|maestro|union\s*pay|card|auth|terminal|merchant|receipt|transaction|order|invoice|loyalty|rewards|member|date|time|qty|quantity|price|size|colour|color|tax|vat|discount|saving|return|survey)\b/i;
const candidateToken = /^[A-Za-z0-9][A-Za-z0-9./_–—-]{3,}$/;

function isGtinValue(value) {
  const text = String(value ?? '').replace(/\s+/g, '');
  if (!/^(?:\d{8}|\d{12,14})$/.test(text)) return false;
  return [...text].reverse().reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0;
}

function isEanValue(value) {
  return /^\d{13}$/.test(String(value ?? '').replace(/\s+/g, ''));
}

function tidyCandidateValue(value) {
  return String(value ?? '').trim().replace(/^[|:;#]+|[|:;]+$/g, '');
}

function candidateFormat(value) {
  const text = tidyCandidateValue(value);
  return candidateToken.test(text) && /\d/.test(text) && text.length >= 4 && text.length <= 32;
}

function candidateChecks(value, entry, source) {
  const text = tidyCandidateValue(value);
  const label = String(entry?.label ?? '');
  const className = entry?.class || (isEanValue(text) ? 'ean' : 'unknown');
  const rejected = paymentClasses.has(className) || ['receipt_or_transaction_number', 'loyalty_or_rewards_number', 'payment_reference'].includes(className)
    || (!label && candidateRejectedLine.test(String(entry?.evidence ?? '')))
    || /(?:receipt|transaction|order|invoice|terminal|merchant|loyalty|rewards|card|auth|date|time|total|amount|price|qty|quantity|size)\b/i.test(text);
  const format = candidateFormat(text);
  const gtinChecksum = !/^\d+$/.test(text) || !/^(?:\d{8}|\d{12,14})$/.test(text) || isGtinValue(text);
  const paymentLike = /^\d{12,19}$/.test(text) || /^(?:19|20)\d{2}$/.test(text);
  return {format, gtinChecksum, paymentLike, rejected, source};
}

function candidateBaseScore(className) {
  return ({physical_item_id: .96, product_id: .94, product_code: .90, sku: .87,
    style_or_model_reference: .84, barcode_or_qr: .80, ean: .80, serial_number: .68}[className] ?? .55);
}

function candidateClass(entry, value) {
  if (isEanValue(value) || entry?.label && /^(?:ean|upc|gtin|barcode)$/i.test(entry.label)) return 'ean';
  return entry?.class || 'unknown';
}

// Printed instructions and links are not receipt fields.
const untrustedText = /ignore\s+previous\s+instructions|\b(?:do\s+not\s+follow|system\s+prompt)\b|https?:\/\/|www\.\S+|\bqr\b[^.\n]{0,40}\b(?:code|scan|visit)\b|\bscan\s+(?:this|the)\s+(?:qr|code)\b|\breturn\s+policy\b|\bsurvey\b|\bplease\s+visit\b/i;

export function isUntrustedReceiptText(text) {
  return untrustedText.test(String(text ?? ''));
}

const labelFinders = [
  {label: 'Card number', class: 'payment_card', re: /\b(?:Card\s*Number|PAN)\s*[:#]?\s*([0-9*•\s-]{8,})/i},
  {label: 'Auth code', class: 'payment_auth', re: /\bAuth(?:orisation|orization)?\s*Code\s*[:#]?\s*(\S+)/i},
  {label: 'Terminal', class: 'payment_terminal', re: /\bTerminal\s*[:#]?\s*(\S+)/i},
  {label: 'Merchant', class: 'payment_merchant', re: /\bMerchant\s*(?:ID|#)?\s*[:#]?\s*(\S+)/i},
  {label: 'Receipt number', class: 'receipt_or_transaction_number', re: /\b(?:Receipt|Transaction)\s*(?:No\.?|Number|#)?\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Loyalty', class: 'loyalty_or_rewards_number', re: /\b(?:Loyalty|Rewards)\s*(?:No\.?|Number|ID|#)?\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Serial Number', class: 'serial_number', re: /\bSerial(?:\s+Number|\s+No\.?)?\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Product Info', class: 'product_code', re: /\bProduct\s+Info\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Product Code', class: 'product_code', re: /\bProduct\s+Code\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'SKU', class: 'sku', re: /\bSKU\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Item No.', class: 'product_id', re: /\bItem\s+No\.?\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Style', class: 'style_or_model_reference', re: /\bStyle\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Model', class: 'style_or_model_reference', re: /\bModel\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'REF', class: 'style_or_model_reference', re: /\bREF\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Article', class: 'product_id', re: /\bArticle\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Reference', class: 'style_or_model_reference', re: /\bReference\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'Barcode', class: 'barcode_or_qr', re: /\b(?:Barcode|QR)\s*[:#]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'ID#', class: 'physical_item_id', re: /\bID\s*#\s*[:.]?\s*([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
  {label: 'ID', class: 'physical_item_id', re: /\bID\s*[:.#]?\s+([A-Za-z0-9?][A-Za-z0-9?.-]*)/i},
];

function tidy(text) {
  return String(text ?? '').trim();
}

export function cardScheme(text) {
  const raw = String(text ?? '');
  if (/\bamerican\s+express\b|\bamex\b/i.test(raw)) return 'Amex';
  if (/\bmaster\s*card\b/i.test(raw)) return 'Mastercard';
  if (/\bmaestro\b/i.test(raw)) return 'Maestro';
  if (/\bvisa\b/i.test(raw)) return 'Visa';
  if (/\bunion\s*pay\b|\bcup\b/i.test(raw)) return 'UnionPay';
  if (/\bdiscover\b/i.test(raw)) return 'Discover';
  if (/\bjcb\b/i.test(raw)) return 'JCB';
  if (/\bdiners\b/i.test(raw)) return 'Diners';
  return null;
}

export function maskPaymentIdentifier(identifierClass, value) {
  const raw = String(value ?? '');
  if (identifierClass === 'payment_card') return '[card]';
  if (identifierClass === 'payment_auth' || identifierClass === 'payment_merchant' || identifierClass === 'payment_terminal' || identifierClass === 'payment_reference')
    return raw.replace(/\d/g, '*');
  return raw;
}

function maskEvidence(identifierClass, evidence) {
  if (!paymentClasses.has(identifierClass)) return evidence;
  if (identifierClass === 'payment_card')
    return String(evidence).replace(/[^A-Za-z]+/g, ' ').replace(/\s+/g, ' ').trim();
  return evidence.replace(/\d/g, '*');
}

function wordConfidence(line, value) {
  const words = line?.words || [];
  const hits = words.filter(word => value.includes(word.text) || word.text.includes(value));
  if (!hits.length) return Number(line?.confidence ?? 0.9);
  return Math.min(...hits.map(word => Number(word.confidence ?? line?.confidence ?? 0.9)));
}

function readLabel(line, text, itemDescription) {
  if (isUntrustedReceiptText(text)) return [];
  const found = [];
  for (const finder of labelFinders) {
    const match = finder.re.exec(text);
    if (!match) continue;
    let value = match[1];
    const alternative = /\(\s*or\s+([^)]+)\)/i.exec(text);
    const alternatives = [];
    if (alternative && alternative[1].trim() !== value) alternatives.push(alternative[1].trim());
    if (/[IO]/.test(value)) {
      const swapped = value.replace(/[IO]/g, ch => ({I: '1', O: '0'}[ch]));
      if (swapped !== value && !alternatives.includes(swapped)) alternatives.push(swapped);
    }
    const unclear = /[?]/.test(value) || Boolean(alternative);
    let confidence = wordConfidence(line, value);
    if (unclear) confidence = Math.min(confidence, 0.5);
    let scheme = null;
    if (finder.class === 'payment_card') {
      scheme = cardScheme(text);
      value = '[card]';
      alternatives.length = 0;
    } else if (paymentClasses.has(finder.class)) {
      value = maskPaymentIdentifier(finder.class, value, text);
      for (let i = 0; i < alternatives.length; i++) alternatives[i] = String(alternatives[i]).replace(/\d/g, '');
    }
    found.push({
      value,
      scheme,
      label: finder.label,
      class: finder.class,
      evidence: maskEvidence(finder.class, text),
      confidence,
      alternatives: alternatives.filter(Boolean),
      itemDescription: itemDescription || null,
    });
    break;
  }
  return found;
}

function joinWrapped(lines, index) {
  const current = tidy(lines[index]?.text);
  const next = tidy(lines[index + 1]?.text);
  const fragment = /^(?:serial|item|product|id|style|model|ref|reference|article|sku|loyalty|rewards|receipt|transaction|auth|terminal|merchant|card)$/i.test(current)
    || /^(?:serial\s+number|item\s+(?:no\.?|number|id|code)|product\s+(?:info|code|id)|receipt\s+(?:no\.?|number)|transaction\s+(?:no\.?|number))$/i.test(current);
  if (fragment && next && !isUntrustedReceiptText(next)) {
    return {text: current + ' ' + next, span: 2, line: lines[index], next: lines[index + 1]};
  }
  return {text: current, span: 1, line: lines[index], next: null};
}

function moneyLine(text) {
  return /(?:^|\s)(?:[£$€]\s*)?\d+(?:,\d{3})*[.,]\d{2}\b/.test(text);
}

function productStart(text) {
  if (!text || isUntrustedReceiptText(text) || isTotalHeading(text)) return false;
  if (!moneyLine(text)) return false;
  if (/^(?:total|balance|amount|sub\s*total|visa|master\s*card|tender|arqc|auth|approved|item\s+total)\b/i.test(text)) return false;
  return /\p{L}{3}/u.test(text.replace(/\b(?:id|sku|serial|product|item|no|number|ref|style|model|code|info)\b/gi, ''));
}

function isTotalHeading(text) {
  return /^(?:(?:grand|order|receipt|net|gross)\s+)?total\b/i.test(text);
}

function descriptionFrom(text) {
  const price = text.search(/(?:^|\s)(?:[£$€]\s*)?\d+(?:,\d{3})*[.,]\d{2}\b/);
  const head = price > 0 ? text.slice(0, price) : text;
  return head.replace(/\s+/g, ' ').trim() || null;
}

function staffOrLabelLine(text) {
  const line = String(text ?? '').trim();
  if (!line) return true;
  if (/^(?:serial(?:\s+number|\s+no\.?)?|id#?|ref#?|product\s+(?:info|code)|sku|style|model|article|item\s+no\.?|barcode)\b/i.test(line)) return true;
  if (/\b(?:salesperson|served by|cashier|associate)\b|\bstaff\b/i.test(line)) return true;
  if (/^(?:visa|master\s*card|maestro|amex|american\s+express|cash|tender(?:ed)?|auth|aid|cryptogram|ogram|pan\s*seq|terminal|merchant\s+id|approved|card\s*number|total|balance|amount)\b/i.test(line)) return true;
  if (/^(?:40|80)\//.test(line)) return true;
  return false;
}

function descriptionFromBlock(block) {
  if (!block) return null;
  for (const part of block.parts) {
    const info = /^product\s+info\s*:\s*\d{6,14}\s+(.+)$/i.exec(part.text);
    if (info && /\p{L}{2}/u.test(info[1]) && !staffOrLabelLine(info[1])) return info[1].replace(/\s+/g, ' ').trim();
  }
  for (const part of block.parts.slice(1)) {
    if (isUntrustedReceiptText(part.text) || isTotalHeading(part.text) || staffOrLabelLine(part.text)) continue;
    if (/^\d{3,14}$/.test(part.text.trim())) continue;
    if (moneyLine(part.text) && !/\p{L}{3}/u.test(part.text)) continue;
    if (/\p{L}{3}/u.test(part.text)) return part.text.replace(/\s+/g, ' ').trim();
  }
  return null;
}
function identifiersOn(line, text, itemDescription) {
  return readLabel(line, text, itemDescription);
}

// Group lines into one block per purchased item, ending at the next item or TOTAL.
export function segmentItemBlocks(lines) {
  const source = lines || [];
  const blocks = [];
  const loose = [];
  let block = null;
  for (let i = 0; i < source.length; i++) {
    const joined = joinWrapped(source, i);
    if (joined.span === 2) i += 1;
    const text = joined.text;
    if (!text || isUntrustedReceiptText(text)) continue;
    if (isTotalHeading(text)) {
      block = null;
      loose.push(joined);
      continue;
    }
    if (productStart(text)) {
      block = {itemDescription: descriptionFrom(text), parts: [joined], identifiers: []};
      blocks.push(block);
      continue;
    }
    if (block) block.parts.push(joined);
    else loose.push(joined);
  }
  for (const entry of blocks) {
    for (const part of entry.parts) {
      entry.identifiers.push(...identifiersOn(part.line, part.text, entry.itemDescription));
    }
  }
  const outside = [];
  for (const part of loose) outside.push(...identifiersOn(part.line, part.text, null));
  return {blocks, identifiers: outside};
}

export function printedItemCount(lines) {
  for (const line of lines || []) {
    const match = /\btotal\s*\(\s*(\d+)\s+items?\s*\)/i.exec(line.text || '');
    if (match) return Number(match[1]);
  }
  return null;
}

export function itemCountCheck(lines, items, excludedZeroItems = []) {
  const printed = printedItemCount(lines);
  const purchased = (items || []).length;
  const withExcludedZeros = purchased + (excludedZeroItems || []).length;
  return {
    printed,
    counted: purchased,
    purchased,
    withExcludedZeros,
    matches: printed == null ? null : printed === purchased || printed === withExcludedZeros,
    evidence: printed == null ? 'No TOTAL (n items) heading was printed.' : 'TOTAL (' + printed + (printed === 1 ? ' item' : ' items') + ')',
  };
}

function choosePrimary(identifiers) {
  for (const kind of primaryOrder) {
    const hit = identifiers.find(entry => entry.class === kind && entry.value);
    if (hit) return {value: hit.value, class: kind, label: hit.label, entry: hit, reason: hit.label + ' is the primary item ID (' + kind + ').'};
  }
  return {value: null, class: null, label: null, entry: null, reason: 'No explicit ID, serial number, or product code was printed for this item.'};
}

function candidateFromEntry(entry, source = 'label', lineIndex = null) {
  const value = tidyCandidateValue(entry?.value);
  // DEBUG_CANDIDATE
  if (value === 'SYN-A' || value === 'SYN-B') console.log('DEBUG', value, candidateClass(entry, value), candidateChecks(value, {...entry, class: candidateClass(entry, value)}, source));
  if (!value || !candidateClasses.has(candidateClass(entry, value))) return null;
  const className = candidateClass(entry, value);
  const checks = candidateChecks(value, {...entry, class: className}, source);
  if (checks.rejected || !checks.format || checks.paymentLike) return null;
  const proximity = source === 'label' ? .08 : source === 'same_line' ? .06 : source === 'next_line' ? .04 : .02;
  const checksum = checks.gtinChecksum && /^\d+$/.test(value) ? .05 : 0;
  const confidence = Math.max(0, Math.min(1, Number(entry?.confidence ?? .8)));
  const score = Math.min(1, candidateBaseScore(className) + proximity + checksum + (confidence - .8) * .1);
  return {
    value,
    class: className,
    label: entry?.label || null,
    source,
    evidence: entry?.evidence || value,
    lineIndex,
    confidence,
    score: Number(score.toFixed(3)),
    reasons: [entry?.label ? 'explicit label' : 'adjacent code line', source.replace('_', ' ')],
    checks,
    alternatives: [...(entry?.alternatives || [])],
  };
}

function unlabelledCandidates(block, item) {
  const found = [];
  const parts = block?.parts || [];
  for (let index = 0; index < parts.length; index++) {
    const text = tidy(parts[index]?.text);
    if (!text || candidateRejectedLine.test(text) || /\p{L}{3}/u.test(text) && !candidateToken.test(text)) continue;
    const words = text.split(/\s+/).map(tidyCandidateValue).filter(Boolean);
    if (words.length !== 1 || !candidateToken.test(words[0])) continue;
    const value = words[0];
    const className = isEanValue(value) ? 'ean' : 'product_code';
    const entry = {value, class: className, label: null, evidence: text, confidence: Number(parts[index]?.line?.confidence ?? .8)};
    const source = index === 0 ? 'same_line' : index === 1 ? 'next_line' : 'chain';
    const candidate = candidateFromEntry(entry, source, index);
    if (candidate) {
      candidate.reasons = ['unlabelled code adjacent to item block', source.replace('_', ' ')];
      if (item?.item && sameName(item.item, block.itemDescription)) candidate.reasons.push('description matched');
      found.push(candidate);
    }
  }
  return found;
}

function dedupeCandidates(entries) {
  const byValue = new Map();
  for (const entry of entries) {
    const key = entry.value.toUpperCase();
    const prior = byValue.get(key);
    if (!prior || entry.score > prior.score) byValue.set(key, entry);
    else if (prior && entry.source !== prior.source) prior.reasons = [...new Set([...prior.reasons, entry.source.replace('_', ' ')])];
  }
  return [...byValue.values()].sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
}

function resolveCandidates(candidates) {
  const valid = candidates.filter(entry => entry.checks?.format && !entry.checks?.rejected && !entry.checks?.paymentLike);
  if (!valid.length) return {value: null, status: 'missing', reason: 'No structurally valid product/item ID candidate was printed.', candidates: []};
  const [best, second] = valid;
  const margin = second ? best.score - second.score : best.score;
  const eligible = ['physical_item_id', 'product_id', 'product_code', 'sku', 'style_or_model_reference', 'ean'].includes(best.class);
  if (!eligible || best.score < .75) return {value: null, status: 'probable', reason: 'A possible identifier was found but its format or evidence is too weak to promote automatically.', candidates: valid};
  if (second && margin < .15) return {value: null, status: 'ambiguous', reason: 'Several possible identifiers are similarly supported. Review the candidates before choosing one.', candidates: valid};
  return {value: best.value, status: best.score >= .85 ? 'confirmed' : 'probable', reason: 'Selected the highest-scoring candidate using its label, position, format, and OCR confidence.', candidates: valid};
}

function itemIdMetadata(item, block, primary) {
  const entries = [];
  const byEntry = new Map();
  for (const [index, part] of (block?.parts || []).entries()) {
    for (const entry of part?.line ? identifiersOn(part.line, part.text, block.itemDescription) : []) byEntry.set(entry, index);
  }
  for (const entry of block?.identifiers || []) {
    const source = entry.class === 'barcode_or_qr' ? 'barcode' : 'label';
    const candidate = candidateFromEntry(entry, source, byEntry.get(entry) ?? null);
    if (candidate) entries.push(candidate);
  }
  entries.push(...unlabelledCandidates(block, item));
  if (item?.itemId) {
    const existing = candidateFromEntry({value: item.itemId, class: 'physical_item_id', label: 'Existing item ID', evidence: item.itemId, confidence: 1}, 'same_line', null);
    if (existing) entries.push(existing);
  }
  if (item?.sku) {
    const existing = candidateFromEntry({value: item.sku, class: 'sku', label: 'Existing SKU', evidence: item.sku, confidence: 1}, 'same_line', null);
    if (existing) entries.push(existing);
  }
  if (item?.styleRef) {
    const existing = candidateFromEntry({value: item.styleRef, class: 'style_or_model_reference', label: 'Existing style/ref', evidence: item.styleRef, confidence: 1}, 'same_line', null);
    if (existing) entries.push(existing);
  }
  if (item?.ean) {
    const existing = candidateFromEntry({value: item.ean, class: 'ean', label: 'Existing EAN', evidence: item.ean, confidence: 1}, 'barcode', null);
    if (existing) entries.push(existing);
  }
  const candidates = dedupeCandidates(entries);
  const decision = resolveCandidates(candidates);
  if (primary?.value && !candidates.some(entry => entry.value === primary.value)) {
    const primaryEntry = candidateFromEntry(primary.entry || {value: primary.value, class: primary.class, label: primary.label, evidence: primary.value, confidence: .8}, 'label', null);
    if (primaryEntry) {
      candidates.push(primaryEntry);
      candidates.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
    }
  }
  return {candidates, decision};
}

function sameName(a, b) {
  const fold = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const left = fold(a), right = fold(b);
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

export function maskCardField(value) {
  if (value == null || value === '') return value;
  const scheme = cardScheme(value);
  if (scheme) return scheme;
  return /\d/.test(String(value)) ? '[card]' : String(value);
}

// Attach identifiers, then refresh 品牌货号 from the style, brand code, or EAN stored on the row.
export function applyItemIdentifiers(data, ocr) {
  const source = data ? {...data} : {};
  const lines = ocr?.lines || [];
  const {blocks, identifiers} = segmentItemBlocks(lines);
  let cursor = 0;
  const filledIndexes = [];
  source.items = (source.items || []).map((item, itemIndex) => {
    let index = blocks.findIndex((entry, position) => position >= cursor && sameName(item.item, entry.itemDescription));
    if (index < 0 && cursor < blocks.length) index = cursor;
    const block = index >= 0 ? blocks[index] : null;
    if (index >= 0) cursor = index + 1;
    const list = block?.identifiers || [];
    const primary = choosePrimary(list);
    let next = {...item, identifiers: list, primaryItemId: primary.value, primaryItemIdReason: primary.reason};
    const ref = list.find(entry => /^ref#?$/i.test(entry.label) && entry.value);
    if (ref && !next.styleRef) next.styleRef = ref.value;
    if (!next.item) {
      const filled = descriptionFromBlock(block);
      if (filled) {
        const sorted = sortItemFields({...next, item: filled});
        const name = sorted.item.item;
        if (name && !staffOrLabelLine(name)) {
          next.item = name;
          if (!next.brand && sorted.item.brand) next.brand = sorted.item.brand;
          if (!next.brandRaw && sorted.item.brandRaw) next.brandRaw = sorted.item.brandRaw;
          filledIndexes.push({index: itemIndex, name});
        }
      }
    }
    const metadata = itemIdMetadata(next, block, primary);
    next = {...next, itemIdCandidates: metadata.candidates, itemIdDecision: metadata.decision};
    const chosen = metadata.decision.value && metadata.candidates.find(entry => entry.value === metadata.decision.value);
    if (!next.itemId && chosen && chosen.class !== 'ean' && chosen.class !== 'serial_number') {
      if (chosen.class === 'style_or_model_reference') {
        if (!next.styleRef) next.styleRef = chosen.value;
      } else if (chosen.class === 'sku') {
        if (!next.sku) next.sku = chosen.value;
      } else next.itemId = chosen.value;
    }
    return next;
  });
  if (filledIndexes.length) {
    const filled = new Set(filledIndexes.map(entry => entry.index));
    source.fieldIssues = (source.fieldIssues || []).filter(issue => {
      const match = /^items\.(\d+)\.item$/.exec(issue.field || '');
      return !(match && issue.reason === 'item_name_missing' && filled.has(Number(match[1])));
    });
    for (const entry of filledIndexes) {
      source.fieldIssues.push({field: 'items.' + entry.index + '.item', reason: 'item_name_filled_from_block', evidence: 'Filled from the item block: ' + entry.name});
    }
  }
  const extra = [];
  const chanel = /^(?:(\d{2}[A-Z])\s+)?([A-Z]{1,3}\d{4,5})\b/;
  const confusable = value => {
    const swapped = String(value).replace(/[IO10]/g, ch => ({I: '1', '1': 'I', O: '0', '0': 'O'}[ch]));
    return swapped === value ? [] : [swapped];
  };
  for (const line of lines) {
    const text = tidy(line.text);
    const styled = chanel.exec(text);
    const season = Boolean(styled && styled[1]);
    if (styled && (season || /chanel/i.test(text))) {
      const entry = {value: text, label: 'Style', class: 'style_or_model_reference', evidence: text, confidence: 0.9, alternatives: confusable(text), itemDescription: null};
      extra.push(entry);
      const target = source.items.find(item => /chanel/i.test(String(item.brand || '') + ' ' + String(item.item || ''))) || (season ? source.items.find(item => item.amount != null) : null);
      if (target && (season || !target.styleRef)) {
        target.styleRef = styled[2];
        target.identifiers = [...(target.identifiers || []), entry];
      }
    } else if (/^[A-Z]{2,}\d{2,}$/.test(text)) {
      const entry = {value: text, label: 'SKU', class: 'product_code', evidence: text, confidence: 0.9, alternatives: confusable(text), itemDescription: null};
      extra.push(entry);
      const target = source.items.find(item => !(item.identifiers || []).some(found => found.value === text));
      if (target) target.identifiers = [...(target.identifiers || []), entry];
    }
  }
  source.items = source.items.map(item => {
    const candidate = brandItemIdCandidate(item);
    return {...item, brandItemIdCandidate: candidate, brandItemId: candidate?.value ?? null};
  });
  source.identifiers = identifiers.concat(extra);
  source.itemCountCheck = itemCountCheck(lines, source.items, source.excludedZeroItems);
  if (source.card) source.card = maskCardField(source.card);
  return source;
}
