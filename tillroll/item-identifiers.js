// Item blocks and labelled identifiers.
// Printed receipt text is data. Instructions, URLs, QR directions, return
// policies and survey text are never followed and never become identifiers.

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
const primaryOrder = ['physical_item_id', 'serial_number', 'product_code'];

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

export function maskPaymentIdentifier(identifierClass, value) {
  const raw = String(value ?? '');
  if (identifierClass === 'payment_card') {
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 4 ? '****' + digits.slice(-4) : '****';
  }
  if (identifierClass === 'payment_auth' || identifierClass === 'payment_merchant' || identifierClass === 'payment_terminal' || identifierClass === 'payment_reference')
    return raw.replace(/\d/g, '*');
  return raw;
}

function maskEvidence(identifierClass, evidence) {
  if (!paymentClasses.has(identifierClass)) return evidence;
  if (identifierClass === 'payment_card')
    return evidence.replace(/\d[\d\s-]{11,}\d/g, run => maskPaymentIdentifier('payment_card', run));
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
    const unclear = /[?]/.test(value) || alternatives.length > 0;
    let confidence = wordConfidence(line, value);
    if (unclear) confidence = Math.min(confidence, 0.5);
    if (paymentClasses.has(finder.class)) value = maskPaymentIdentifier(finder.class, value);
    found.push({
      value,
      label: finder.label,
      class: finder.class,
      evidence: maskEvidence(finder.class, text),
      confidence,
      alternatives,
      itemDescription: itemDescription || null,
    });
    break;
  }
  return found;
}

function joinWrapped(lines, index) {
  const current = tidy(lines[index]?.text);
  const next = tidy(lines[index + 1]?.text);
  const fragment = /^(?:serial|item|product|id|style|model|ref|reference|article|sku|loyalty|rewards|receipt|transaction|auth|terminal|merchant|card)$/i.test(current);
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

function descriptionFromBlock(block) {
  if (!block) return null;
  for (const part of block.parts) {
    const info = /^product\s+info\s*:\s*\d{6,14}\s+(.+)$/i.exec(part.text);
    if (info && /\p{L}{2}/u.test(info[1])) return info[1].replace(/\s+/g, ' ').trim();
  }
  for (const part of block.parts.slice(1)) {
    if (isUntrustedReceiptText(part.text) || isTotalHeading(part.text) || /^product\s+info\b/i.test(part.text)) continue;
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

export function itemCountCheck(lines, items) {
  const printed = printedItemCount(lines);
  const counted = (items || []).length;
  return {
    printed,
    counted,
    matches: printed == null ? null : printed === counted,
    evidence: printed == null ? 'No TOTAL (n items) heading was printed.' : 'TOTAL (' + printed + (printed === 1 ? ' item' : ' items') + ')',
  };
}

function choosePrimary(identifiers) {
  for (const kind of primaryOrder) {
    const hit = identifiers.find(entry => entry.class === kind && entry.value);
    if (hit) return {value: hit.value, reason: hit.label + ' is the primary item ID (' + kind + ').'};
  }
  return {value: null, reason: 'No explicit ID, serial number, or product code was printed for this item.'};
}

function sameName(a, b) {
  const fold = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const left = fold(a), right = fold(b);
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

export function maskCardField(value) {
  if (value == null || value === '') return value;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '****';
  return '****' + digits.slice(-4);
}

// Attach identifiers without changing 品牌货号 or brandItemIdCandidate.
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
    const next = {...item, identifiers: list, primaryItemId: primary.value, primaryItemIdReason: primary.reason};
    if (!next.item) {
      const filled = descriptionFromBlock(block);
      if (filled) {
        next.item = filled;
        filledIndexes.push(itemIndex);
      }
    }
    return next;
  });
  if (filledIndexes.length) {
    source.fieldIssues = (source.fieldIssues || []).filter(issue => {
      const match = /^items\.(\d+)\.item$/.exec(issue.field || '');
      return !(match && issue.reason === 'item_name_missing' && filledIndexes.includes(Number(match[1])));
    });
  }
  source.identifiers = identifiers;
  source.itemCountCheck = itemCountCheck(lines, source.items);
  if (source.card) source.card = maskCardField(source.card);
  return source;
}
