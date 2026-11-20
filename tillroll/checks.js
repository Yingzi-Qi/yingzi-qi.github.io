// Geometry is normalized to the upright photo, with the origin at its top left.
const PHOTO_CONFIDENCE = 0.8;
const ID_LABEL = /^order\s+i\.?d\.?\s*[:#]?$/i;
const INLINE_ID = /^order\s+i\.?d\.?(?:\s*[:#]\s*|\s+)(\S+)$/i;
const PRICE = /^(?:[£€$]\s*)?\d[\d,]*\.\d{2}$/;
const TRAILING_PRICE = /\s+(?:[£€$]\s*|(?:GBP|EUR|USD)\s+)\d[\d,]*\.\d{2}$/i;
const retailFormats = [
  ['harrods', /^HRD\d{8}$/], ['selfridges', /^SLF-\d{9}$/],
  ['harveynichols', /^HN\d{7}$/], ['liberty', /^LIB\d{7}$/],
  ['fortnum', /^FM-\d{8}$/], ['flannels', /^FL\d{9}$/],
  ['netaporter', /^\d{4}-\d{6}-\d{4}$/], ['bicester', /^BV\d{8}$/],
];
const text = value => String(value ?? '').trim();
const name = value => text(value).toLowerCase().replace(/\s+/g, ' ');
const identifier = value => name(value).replace(/[^a-z0-9]/g, '');
const number = value => text(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const near = (a, b) => Math.abs(a - b) <= 0.020000001;
const money = value => value.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const avg = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const unique = values => [...new Set(values)];
const foldGlyphs = str => identifier(str).replace(/o/g, '0').replace(/[il]/g, '1').replace(/s/g, '5').replace(/b/g, '8').replace(/z/g, '2');

function hasGeometry(box) {
  return box && text(box.text) && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0;
}

function joinBoxes(boxes) {
  const x = Math.min(...boxes.map(b => b.x));
  const y = Math.min(...boxes.map(b => b.y));
  return {
    text: boxes.map(b => text(b.text)).join(' '), x, y,
    w: Math.max(...boxes.map(b => b.x + b.w)) - x,
    h: Math.max(...boxes.map(b => b.y + b.h)) - y,
    confidence: avg(boxes.map(b => Number(b.confidence) || 0)),
  };
}

function visualLines(ocr) {
  const center = b => b.y + b.h / 2;
  const boxes = (ocr?.lines || []).filter(hasGeometry).sort((a, b) => center(a) - center(b) || a.x - b.x);
  const rows = [];
  for (const box of boxes) {
    const row = rows.at(-1);
    if (row && Math.abs(center(row[0]) - center(box)) <= .45 * Math.min(row[0].h, box.h)) row.push(box);
    else rows.push([box]);
  }
  return rows.map(row => {
    row.sort((a, b) => a.x - b.x);
    const words = row.flatMap(box => {
      const words = box.words?.filter(hasGeometry);
      return words?.length ? words : [box];
    }).sort((a, b) => a.x - b.x);
    const groups = [];
    for (const word of words) {
      const group = groups.at(-1);
      const prior = group?.at(-1);
      const glyph = Math.max(word.w / text(word.text).length, prior ? prior.w / text(prior.text).length : 0);
      if (prior && word.x - prior.x - prior.w < Math.max(.014, 1.65 * glyph)) group.push(word);
      else groups.push([word]);
    }
    return {...joinBoxes(row), cells: groups.map(joinBoxes)};
  });
}

function adjacent(a, b) {
  const gap = b.y - a.y - a.h;
  return Math.abs(a.x - b.x) <= .055 && gap >= -.3 * a.h && gap <= Math.min(.055, 1.25 * Math.max(a.h, b.h));
}

function printedIds(lines) {
  const ids = [];
  for (const [i, line] of lines.entries()) {
    const inline = line.text.match(INLINE_ID);
    if (inline) {
      ids.push({id: inline[1], evidence: line.text, confidence: line.confidence});
      continue;
    }
    for (const [j, cell] of line.cells.entries()) {
      const match = cell.text.match(INLINE_ID);
      if (match) { ids.push({id: match[1], evidence: cell.text, confidence: cell.confidence}); continue; }
      if (!ID_LABEL.test(cell.text)) continue;
      const right = line.cells[j + 1];
      const below = lines[i + 1]?.cells.filter(candidate => adjacent(cell, candidate)) || [];
      // A neighbouring heading (e.g. DATE) is never the value of the ID label.
      const idShaped = b => b && /^\S+$/.test(b.text) && /\d/.test(b.text);
      const value = idShaped(right) ? right : (below.length === 1 && /^\S+$/.test(below[0].text) ? below[0] : null);
      if (value) ids.push({id: value.text, evidence: cell.text + ' / ' + value.text,
        confidence: Math.min(cell.confidence, value.confidence)});
    }
  }
  return ids;
}

function productLines(lines) {
  return lines.map(line => {
    const cells = [...line.cells];
    let hadPrice = false;
    while (cells.length > 1 && PRICE.test(cells.at(-1).text)) { cells.pop(); hadPrice = true; }
    if (hadPrice && cells.length > 1 && /^\d+$/.test(cells.at(-1).text)) cells.pop();
    const wording = cells.map(c => c.text).join(' ').replace(TRAILING_PRICE, '');
    return {line, cells, wording: name(wording), confidence: Math.min(...cells.map(c => c.confidence))};
  });
}

function productEvidence(lines, brand, item) {
  const hits = [];
  let brandEvidence = '', itemEvidence = '';
  for (const [i, {line, wording, cells, confidence}] of lines.entries()) {
    const split = cells.some((_, splitAt) => splitAt > 0 &&
      name(cells.slice(0, splitAt).map(c => c.text).join(' ')) === brand &&
      name(cells.slice(splitAt).map(c => c.text).join(' ').replace(TRAILING_PRICE, '')) === item);
    const delimiter = [' - ', ' – ', ' | ', ': '].some(separator => wording === brand + separator + item);
    if (split || delimiter) hits.push({rows:[i], brand:line.text, item:line.text, confidence});
    if (wording === item) {
      itemEvidence = line.text;
      const prior = lines[i - 1];
      if (prior?.wording === brand && adjacent(prior.line, line)) {
        hits.push({rows:[i - 1, i], brand:prior.line.text, item:line.text, confidence:Math.min(prior.confidence, confidence)});
      }
    } else if (wording.endsWith(' ' + item)) itemEvidence = line.text;
    if (wording === brand || wording.startsWith(brand + ' ')) brandEvidence = line.text;
  }
  if (!hits.length && itemEvidence) brandEvidence = '';
  return {hits, brandEvidence, itemEvidence};
}

function verifyPhoto(data, ocr, independent) {
  const lines = visualLines(ocr), ids = printedIds(lines);
  const idEvidence = unique(ids.map(id => id.evidence)).join(' | ');
  const orderId = text(data.orderId);
  let idIssue = '';
  if (!orderId) idIssue = 'The extracted order ID is empty.';
  else if (!ids.length) idIssue = 'Could not read a labelled order ID.';
  else if (ids.some(entry => entry.id !== orderId)) idIssue = 'The printed order ID differs or the photo shows conflicting IDs.';
  else if (Math.max(...ids.map(id => id.confidence)) < PHOTO_CONFIDENCE) idIssue = 'The printed ID is unclear.';

  const products = productLines(lines);
  const groups = new Map(), owners = new Map();
  const items = data.items || [];
  for (const [i, product] of items.entries()) {
    const brand = name(product.brand), item = name(product.item), key = JSON.stringify([brand,item]);
    if (!groups.has(key)) {
      const match = brand && item ? productEvidence(products, brand, item) : null;
      groups.set(key, {positions:[], match});
      for (const hit of match?.hits || []) for (const row of hit.rows) {
        if (!owners.has(row)) owners.set(row, new Set());
        owners.get(row).add(key);
      }
    }
    groups.get(key).positions.push(i);
  }
  const result = Array(items.length);
  for (const {positions, match} of groups.values()) {
    const enough = match?.hits.length === positions.length;
    const collides = match?.hits.some(h => h.rows.some(i => owners.get(i).size > 1));
    for (const [index, i] of positions.entries()) {
      const issueList = idIssue ? [idIssue] : [];
      const hit = match?.hits[index] || match?.hits[0];
      if (!match) issueList.push('A brand or item description is missing.');
      else if (!match.hits.length) issueList.push('The full item and brand could not be paired on the printed line.');
      else if (!enough || collides) issueList.push('Repeated or overlapping product lines could not be paired uniquely.');
      else if (hit.confidence < PHOTO_CONFIDENCE) issueList.push('The product line is unclear.');
      result[i] = {
        status: issueList.length ? 'Needs review' : independent ? 'Confirmed on photo' : 'Text agrees',
        reason: issueList.join(' ') || (independent ? 'Independent extraction agrees with the printed ID, brand and item.' : 'The OCR text contains the labelled order ID and this brand and item together.'),
        idEvidence, brandEvidence:hit?.brand || match?.brandEvidence || '', itemEvidence:hit?.item || match?.itemEvidence || '',
      };
    }
  }
  return result;
}

function inspectDate(value, now, flag) {
  if (!text(value)) return flag('date', 'Purchase date is missing.', 'fix');
  const parsed = new Date(text(value) + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0,10) !== value)
    return flag('date', 'Purchase date is invalid.', 'fix');
  const today = new Date(now);
  if (+parsed > +today + 86400000) flag('date','Purchase date is in the future. Check the day and month.', 'fix');
  const fiveYearsAgo = new Date(today);
  fiveYearsAgo.setUTCFullYear(today.getUTCFullYear() - 5);
  if (parsed < fiveYearsAgo) flag('date','Purchase date is more than five years ago.', 'check');
}

function includedLineDiscount(item) {
  const discount=number(item.lineDiscount), qty=number(item.qty), price=number(item.unitPrice), amount=number(item.amount);
  if(discount===null || discount<=0 || qty===null || price===null || amount===null) return 0;
  return near(qty*price-discount,amount) ? discount : 0;
}

function arithmetic(data, items, flag, repeats) {
  const amounts = items.map(i => number(i.amount)), total = number(data.total);
  const sum = amounts.reduce((a, b) => a + (b || 0), 0), tax = number(data.tax);
  const alreadyApplied = items.reduce((value,item)=>value+includedLineDiscount(item),0);
  const discount = Math.max(0,(number(data.discount) ?? 0)-alreadyApplied);
  const balances = beforeDiscount => total !== null && (
    near(beforeDiscount - discount, total) || (tax !== null && near(beforeDiscount - discount + tax, total)));
  const repeated = new Map();
  for (const [i, item] of items.entries()) {
    const key = JSON.stringify([name(item.item) || name(item.sku), amounts[i]]);
    if (!(text(item.item) || text(item.sku)) || amounts[i] === null) continue;
    if (!repeated.has(key)) repeated.set(key, []);
    repeated.get(key).push(i);
  }
  let explained = false;
  for (const indices of repeated.values()) {
    if (indices.length < 2) continue;
    const complete = amounts.every(n => n !== null);
    if (complete && balances(sum)) {
      for (const i of indices) repeats[i] = 'Repeat confirmed';
      flag('items.'+indices[1]+'.item','Repeated lines reconcile with the printed total.', 'info');
    } else {
      const remove = complete && balances(sum - amounts[indices[0]] * (indices.length - 1));
      explained ||= remove;
      for (const i of indices.slice(1)) {
        repeats[i] = remove ? 'Possible duplicate' : 'Check repeat';
        flag('items.'+i+'.item', remove ? 'The total reconciles only after removing the repeated row.' : 'Check whether this item was bought more than once.', remove ? 'fix' : 'check');
      }
    }
  }
  if (total !== null && items.length && !explained && !balances(sum))
    flag('total', 'Line amounts after discount total ' + money(sum - discount) + '. The receipt total is ' + money(total) + '.', 'fix');
}

function ocrChecks(data, ocr, format, add, confirmed) {
  const content = text(ocr?.text);
  if (!ocr || ocr.confidence < .75 || content.length < 80) {
    if (ocr && text(data.orderNumber)) add('orderNumber', 'The OCR reading is too short or unclear to cross-check the order number.', 'info', true);
    return;
  }
  for (const key of ['orderNumber','orderId']) {
    const value = text(data[key]), normalized = identifier(value);
    if (normalized.length < 5) continue;
    const validFormat = key === 'orderNumber' && format?.test(value);
    if (identifier(content).includes(normalized)) confirmed.push(key);
    else if (foldGlyphs(content).includes(foldGlyphs(value))) {
      if (validFormat) confirmed.push(key);
      else add(key, 'OCR found a lookalike character in this identifier.', 'check', false);
    } else if (!validFormat) add(key, 'OCR could not find this identifier.', 'check');
  }
  if (number(data.total) !== null && identifier(content).includes(identifier(number(data.total).toFixed(2)))) confirmed.push('total');
}

export function checkReceipt(data, ocr, previous = null, {independentPhoto = false, today = new Date()} = {}) {
  const items = data.items || [], flags = [], confirmedFields = [];
  const repeats = Array(items.length).fill(null);
  const add = (field, message, severity, escalate = severity !== 'info') => {
    if (!flags.some(flag => flag.field === field && flag.message === message))
      flags.push({field, message, severity, escalate});
  };
  if (!items.length) add('receipt','No line items were read.', 'fix');
  if (!text(data.merchant)) add('merchant','Retailer is missing.', 'fix');
  if (number(data.total) === null) add('total','Receipt total is missing or unreadable.', 'fix');
  inspectDate(data.date, today, add);
  const retailer = identifier(data.merchant);
  const format = retailFormats.find(([key]) => retailer.includes(key))?.[1];
  if (!text(data.orderNumber)) add('orderNumber', text(data.orderId) ? 'Order number is missing. An order ID was read.' : 'Both order references are missing.', text(data.orderId) ? 'check' : 'fix');
  else if (format && !format.test(data.orderNumber)) add('orderNumber','The order number differs from this retailer’s expected format.', 'check');
  else if (!format) add('orderNumber','This retailer has no configured order-number format.', 'info');

  items.forEach((item,i) => {
    const path = 'items.'+i+'.';
    if (!text(item.item)) add(path+'item',text(item.sku) ? 'Only the product code was read.' : 'Item description is missing.', 'fix');
    else if (/^[A-Z\d/ .-]{4,24}$/.test(item.item) && /\d/.test(item.item)) add(path+'item','The item description looks like a product code.', 'check');
    if (text(item.item) && !text(item.brand)) add(path+'brand','No brand was read for this item.', 'info');
    const amount = number(item.amount), qty = number(item.qty), unit = number(item.unitPrice);
    if (amount === null) add(path+'amount','Line amount is missing or unreadable.', 'fix');
    else if (qty !== null && unit !== null && !near(qty*unit-includedLineDiscount(item), amount)) add(path+'amount','Quantity multiplied by unit price differs from the line amount.', 'fix');
  });
  arithmetic(data, items, add, repeats);
  for (const issue of Array.isArray(data.fieldIssues) ? data.fieldIssues : []) {
    const field = text(issue?.field);
    if (!/^(merchant|orderId|orderNumber|date|total|items\.\d+\.(item|amount))$/.test(field) || issue.reason === 'missing_on_receipt') continue;
    if (!flags.some(f => f.field === field && f.severity !== 'info'))
      add(field,'Hard to read' + (issue.evidence ? '. '+text(issue.evidence) : '.') , 'check');
  }
  if (name(data.imageQuality) === 'poor' && !flags.some(f => f.escalate)) add('receipt','Image quality is poor.', 'check');
  ocrChecks(data, ocr, format, add, confirmedFields);
  for (const key of ['orderNumber','orderId']) {
    if (text(previous?.[key]) && text(data[key]) && text(previous[key]) !== text(data[key]))
      add(key,'The two readings disagree. First reading: '+text(previous[key])+'.', 'check', false);
  }
  const photo = verifyPhoto(data, ocr, independentPhoto);
  photo.forEach((row, i) => {
    if (row.status === 'Needs review') add('items.'+i+'.photo', row.reason, 'check', true);
  });
  return {flags, photo, repeats, confirmedFields};
}

export function samePurchase(a, b) {
  if (!a || !b || !identifier(a.merchant) || identifier(a.merchant) !== identifier(b.merchant)) return false;
  const refs = obj => [obj.orderId, obj.orderNumber].map(identifier).filter(r => r.length >= 5);
  if (refs(a).some(r => refs(b).includes(r))) return true;
  if (!text(a.date) || a.date !== b.date || number(a.total) === null || number(a.total) !== number(b.total)) return false;
  if (text(a.card) && text(a.card) === text(b.card)) return true;
  if (text(a.time) && text(a.time) === text(b.time)) return true;
  const amounts = obj => (obj.items || []).map(i => number(i.amount)).sort((l,r) => l - r);
  const left = amounts(a), right = amounts(b);
  return left.length > 0 && left.length === right.length && left.every((v, i) => v !== null && v === right[i]);
}
