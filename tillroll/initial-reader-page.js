import { readPhoto, secondReadPhoto, extractStrictReceipt, extractAI } from './extract.js?v=discounts1';
import { initialReceiptFromStrict, reconcileInitialReadings } from './initial-reader.js';

const files = document.querySelector('#reader-files');
const run = document.querySelector('#reader-run');
const status = document.querySelector('#reader-status');
const results = document.querySelector('#reader-results');
const initialReaderEndpoint = ['/api', 'initial-reader'].join('/');

async function digest(file) {
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function readingFromOcr(first, second, imageHash) {
  const candidates = [first, second].filter(Boolean).map(ocr => initialReceiptFromStrict(extractStrictReceipt(ocr), { source: 'local-ocr', rawText: ocr.text, imageHash }));
  const selected = candidates.sort((a, b) => a.flags.length - b.flags.length)[0] || null;
  if (!selected || candidates.length < 2) return selected;
  const fields = ['receiptId', 'date', 'time', 'paymentMethod', 'totalPaid'];
  for (const field of fields) {
    if (candidates.every(candidate => candidate[field] !== null && candidate[field] !== undefined) && new Set(candidates.map(candidate => String(candidate[field]))).size > 1) {
      selected[field] = null;
      selected.flags.push({ field, code: 'ocr_disagreement', severity: 'Pink', reason: 'The two local OCR passes produced different values.' });
    }
  }
  if (candidates.some(candidate => candidate.items.length !== selected.items.length)) {
    selected.items = [];
    selected.flags.push({ field: 'items', code: 'ocr_disagreement', severity: 'Pink', reason: 'The two local OCR passes produced different item counts.' });
  } else {
    for (const [index, item] of selected.items.entries()) {
      const alternatives = candidates.map(candidate => candidate.items[index]);
      for (const field of ['itemPrice', 'purchasePrice', 'brand', 'name', 'reference']) {
        const values = alternatives.map(candidate => candidate[field]).filter(value => value !== null && value !== undefined);
        if (values.length === alternatives.length && new Set(values.map(value => String(value))).size > 1) {
          item[field] = null;
          selected.flags.push({ field: `items[${index}].${field}`, code: 'ocr_disagreement', severity: 'Pink', reason: 'The two local OCR passes produced different values.' });
        }
      }
    }
  }
  selected.reviewRequired = selected.flags.length > 0;
  selected.status = selected.reviewRequired ? 'review' : 'ready';
  return selected;
}

function renderReading(file, reading, server) {
  const box = document.createElement('article');
  box.className = 'reader-card reader-result';
  const title = document.createElement('h2');
  title.textContent = file.name;
  box.append(title);
  const summary = document.createElement('pre');
  summary.textContent = JSON.stringify({ receiptId: reading.receiptId, date: reading.date, time: reading.time, paymentMethod: reading.paymentMethod, totalPaid: reading.totalPaid, items: reading.items.map(item => ({ itemPrice: item.itemPrice, purchasePrice: item.purchasePrice, brand: item.brand, name: item.name, reference: item.reference })) }, null, 2);
  box.append(summary);
  const flags = [...(server?.reviewFlags || reading.flags)];
  if (!flags.length) {
    const ok = document.createElement('p');
    ok.textContent = 'Fundamentals read without a review flag.';
    box.append(ok);
  } else {
    const list = document.createElement('div');
    for (const flag of flags) {
      const item = document.createElement('div');
      item.className = `reader-flag ${flag.severity === 'Pink' ? 'pink' : ''}`;
      item.textContent = `${flag.field}: ${flag.reason}`;
      list.append(item);
    }
    box.append(list);
  }
  if (server?.matches?.length) {
    const matches = document.createElement('pre');
    matches.textContent = JSON.stringify(server.matches.map(match => ({ status: match.status, matchType: match.matchType, officialMatch: match.officialMatch, candidates: match.candidates?.slice(0, 3) })), null, 2);
    box.append(matches);
  }
  results.append(box);
}

async function processFile(file) {
  const imageHash = await digest(file);
  const [first, second] = await Promise.all([readPhoto(file), secondReadPhoto(file)]);
  let reading = readingFromOcr(first, second, imageHash);
  if (!reading) throw new Error('The local OCR engine returned no reading.');
  const fundamentalFields = new Set(['receiptId', 'date', 'time', 'paymentMethod', 'totalPaid']);
  const needsServerFallback = reading.flags.some(flag => fundamentalFields.has(flag.field) || /^items\[\d+\]\.(itemPrice|purchasePrice)$/.test(flag.field));
  if (needsServerFallback) {
    try {
      const serverReading = initialReceiptFromStrict(await extractAI(file, '__server__', 2, reading.flags.map(flag => flag.reason)), { source: 'server-ocr', imageHash });
      reading = reconcileInitialReadings(reading, serverReading);
    } catch {
      reading.flags.push({ field: 'ocr', code: 'server_ocr_unavailable', severity: 'Amber', reason: 'The stronger server OCR fallback was unavailable. The local reading remains for review.' });
    }
  }
  let server = null;
  try {
    const response = await fetch(initialReaderEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reading }) });
    if (response.ok) {
      server = await response.json();
      reading = server.reading || reading;
    }
    else throw new Error(`Server reader returned ${response.status}.`);
  } catch (error) {
    reading.flags.push({ field: 'server', severity: 'Amber', reason: `${error.message} The local reading is shown for review.` });
  }
  renderReading(file, reading, server);
}

run.addEventListener('click', async () => {
  const selected = [...(files.files || [])];
  if (!selected.length) { status.textContent = 'Choose at least one receipt photo.'; return; }
  run.disabled = true;
  results.replaceChildren();
  for (const [index, file] of selected.entries()) {
    status.textContent = `Reading ${index + 1} of ${selected.length}…`;
    try { await processFile(file); }
    catch (error) {
      const failed = document.createElement('p');
      failed.className = 'reader-flag pink';
      failed.textContent = `${file.name}: ${error.message}`;
      results.append(failed);
    }
  }
  status.textContent = `Read ${selected.length} photo${selected.length === 1 ? '' : 's'}.`;
  run.disabled = false;
});
