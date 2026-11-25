// Server-side review loop behind /api/sanity-run. Encodes the Operating Manual
// roles (Reader & Sanity Checker -> Look-up Verifier -> Reader cross-check ->
// Excel Sync audit) and iterates until the audit converges. Only the final
// agreed version leaves this module; the internal trail is stored in D1 only.
import { canonicalBrand } from './brands.js';
import { lookup as defaultLookup, invalidate } from './lookup.js';
import { nowIso, sha256Hex } from './http.js';
import { expandReceipt, joinPurchaseTime, supplierVisibleName } from '../../../tillroll/units.js';

export const COLUMNS = ['采购小票id', '采购时间', '供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额', '采购商品方法', '销售金额'];
export const PINK = '#FECDD3', AMBER = '#FDE68A';
const MAX_LOOKUPS_PER_RUN = 60, MAX_ITERATIONS = 3;
const str = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[£$€,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Shared with the workbook exporter so a receipt's 采购时间 is identical in both.
export const normaliseTimestamp = joinPurchaseTime;

const JUNK_NAME = /^(amount|total|sub-?total|vat|tax|change|cash|card|balance|due|tender|discount|9{3,}|[\d\s.,£$€-]+)$/i;
export function itemIdProblem(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) return 'looks like a date';
  if (/^\d+[.,]\d{2}$/.test(s)) return 'looks like a price';
  if (/^(\+?44|0)\d{9,10}$/.test(s.replace(/\s/g, ''))) return 'looks like a phone number';
  if (/^\d{4}$/.test(s)) return 'looks like card last-4';
  return null;
}
export function stripBrandFromItemId(itemId, brand) {
  const id = str(itemId);
  if (!id || !brand) return id;
  const names = [...new Set([brand, canonicalBrand(brand)].filter(Boolean))];
  let out = id;
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^${esc}[\\s:#-]*`, 'i'), '').replace(new RegExp(`[\\s:#-]*${esc}$`, 'i'), '');
  }
  return out.trim() || id;
}
const TENDERS = [[/apple\s*pay/i, 'Apple Pay'], [/google\s*pay/i, 'Google Pay'], [/ali\s*pay/i, 'Alipay'], [/we\s*chat/i, 'WeChat'], [/amex|american express/i, 'Amex'],
  [/master\s*card|mastercard/i, 'Mastercard'], [/maestro/i, 'Maestro'], [/visa/i, 'Visa'], [/union\s*pay/i, 'UnionPay'], [/cash/i, 'Cash'], [/carte\s*(bleue|bancaire)|card|debit|credit/i, null]];
export function normaliseTender(p) {
  const s = str(p);
  if (!s) return null;
  for (const [re, name] of TENDERS) if (re.test(s)) return name || s;
  return s;
}

function addFlag(row, col, colour, reason, extra = {}) {
  const prev = row.flags[col];
  // Mixed reading + look-up uncertainty is Amber (manual 7E.19).
  row.flags[col] = prev && prev !== colour ? AMBER : colour;
  (colour === PINK ? row._reading : row._lookup).push({ col, reason, ...extra });
}
// Receipt wins on prices and 品牌货号. Official site wins on 品牌 and 品名.
// The value that is NOT in the cell is kept for the Excel comment and hidden column.
function noteMismatch(row, col, receipt, official, shown) {
  if (receipt === null || receipt === undefined || official === null || official === undefined) return;
  if (String(receipt) === String(official)) return;
  if (!row._alternates) row._alternates = {};
  if (!row._comments) row._comments = {};
  row._alternates[col] = { receipt, official, shown };
  row._comments[col] = shown === 'official' ? `Receipt printed: ${receipt}` : `Official site: ${official}`;
}

// ---- Stage 1: Receipt Reader & Sanity Checker ------------------------------
function readerStage(receipt, rIndex, state) {
  const rows = [];
  const merchant = str(receipt.merchant);
  const receiptId = str(receipt.receiptReference) || str(receipt.orderNumber) || str(receipt.orderId);
  const ts = normaliseTimestamp(receipt.date, receipt.time);
  const tender = normaliseTender(receipt.payment);
  const items = Array.isArray(receipt.items) ? receipt.items : [];
  items.forEach((it, i) => {
    const qty = num(it.qty) ?? 1;
    const unit = num(it.unitPrice), amount = num(it.amount), discount = num(it.discount) ?? 0;
    const lineIndex = it.lineIndex ?? i;
    // Zero-price exclusion: only a confirmed true printed 0 is dropped.
    const zeroUnit = unit === 0, zeroAmt = amount === 0;
    const confirmedZero = (it.zeroConfirmed === true && (zeroUnit || zeroAmt)) || (zeroUnit && zeroAmt && it.zeroConfirmed !== false);
    if (confirmedZero) { state.excludedZero.push({ receiptKey: receipt.receiptKey, lineIndex, name: str(it.item) }); return; }
    const brandRaw = str(it.brand);
    const row = { rowId: it.rowId || `${receipt.receiptKey}:${lineIndex}:u0`, receiptKey: receipt.receiptKey, lineIndex, unitIndex: it.unitIndex ?? 0, flags: {}, notes: [], _reading: [], _lookup: [], _alternates: {}, _comments: {}, _candidates: null, _officialBranch: null, lookup: null, discountKind: it.discountKind || 'none',
      cells: { '采购小票id': receiptId, '采购时间': ts, '供应商': merchant, '品牌': brandRaw, '品名': str(it.item), '品牌货号': stripBrandFromItemId(it.itemId ?? it.sku, brandRaw),
        '采购商品原价': unit ?? (amount !== null ? round2((amount + discount) / (qty || 1)) : null), '采购商品金额': amount, '采购商品方法': tender, '销售金额': null },
      raw: { style: str(it.sku) !== str(it.itemId) ? str(it.sku) : null, colour: str(it.colour), size: str(it.size), qty, currency: str(receipt.currency) } };
    if (!receiptId) addFlag(row, '采购小票id', PINK, /selfridges/i.test(merchant || '') ? 'Selfridges receipt number (below the barcode) not read.' : /harrods/i.test(merchant || '') ? 'Harrods receipt number (right of date/time) not read.' : 'Receipt ID not read.');
    if (!ts) addFlag(row, '采购时间', PINK, 'Date/time missing or not a valid date.');
    if (!merchant) addFlag(row, '供应商', PINK, 'Supplier not read.');
    if (!tender) addFlag(row, '采购商品方法', PINK, 'Payment tender not read.');
    if (!row.cells['品名'] || JUNK_NAME.test(row.cells['品名'])) addFlag(row, '品名', PINK, `Item name "${row.cells['品名'] ?? ''}" failed the column sanity check.`);
    const idp = itemIdProblem(row.cells['品牌货号']);
    if (idp) addFlag(row, '品牌货号', PINK, `Item ID ${idp}.`);
    if ((it.fieldIssues || []).some(f => /itemid/i.test(f))) addFlag(row, '品牌货号', PINK, 'Reader marked the item ID as uncertain.');
    if (unit === null && amount === null) addFlag(row, '采购商品原价', PINK, 'No price read.');
    else if (unit === null) addFlag(row, '采购商品原价', PINK, 'Unit price not printed; derived from line amount.');
    if ((zeroUnit || zeroAmt) && row.flags['采购商品原价'] !== PINK) addFlag(row, '采购商品原价', PINK, 'Doubtful 0 price: may be an OCR miss.');
    if (amount === null) addFlag(row, '采购商品金额', PINK, 'Line amount not read.');
    else if (unit !== null && Math.abs(qty * unit - discount - amount) > 0.02 && Math.abs(qty * unit - amount) > 0.02) addFlag(row, '采购商品金额', PINK, `qty × unit price − discount (${round2(qty * unit - discount)}) does not match amount (${amount}).`);
    for (const col of it.readingFlags || []) if (COLUMNS.includes(col)) addFlag(row, col, PINK, 'Flagged by the reader.');
    // Printed per-unit discounts are exact. Only a proportional estimate is Amber.
    if (it.discountKind === 'estimated' && typeof row.cells['采购商品金额'] === 'number') {
      addFlag(row, '采购商品金额', AMBER, 'Discount allocated proportionally from a line or receipt total (not printed per unit).');
    }
    rows.push(row);
  });
  return rows;
}

// ---- Stage 2: Brand & Catalogue Look-up Verifier --------------------------
async function verifierStage(rows, receipt, ctx) {
  const canon = canonicalBrand(rows[0]?.cells['供应商']);
  // Branch suffix once per receipt (multi-store UK suppliers).
  const sc = receipt.storeClues;
  if (rows.length && sc && (sc.postcode || (sc.addressLines || []).length || sc.storeNumber) && rows[0].cells['供应商']) {
    const res = await ctx.callLookup({ supplier: rows[0].cells['供应商'], storeClues: sc });
    const name = res?.branch?.officialStoreName;
    const printedSupplier = rows[0].cells['供应商'];
    const visible = name ? supplierVisibleName(printedSupplier, name) : printedSupplier;
    for (const row of rows) row._officialBranch = name || null;
    if (name && visible && visible !== printedSupplier) for (const row of rows) {
      if (ctx.locked(row.rowId, '供应商')) continue;
      noteMismatch(row, '供应商', printedSupplier, visible, 'official');
      row.cells['供应商'] = visible;
      addFlag(row, '供应商', AMBER, 'Official UK branch name from look-up.', { sourceUrls: res.branch.sourceUrls || [] });
    }
  }
  void canon;
  for (const row of rows) {
    const c = row.cells;
    // Brand canonicalisation (abbreviation expansion / sub-department collapse).
    if (c['品牌']) {
      const printedBrand = c['品牌'];
      const cb = canonicalBrand(printedBrand);
      if (cb && cb !== printedBrand && !ctx.locked(row.rowId, '品牌')) {
        noteMismatch(row, '品牌', printedBrand, cb, 'official');
        c['品牌'] = cb;
        addFlag(row, '品牌', AMBER, 'Brand expanded to the official name.');
      }
    }
    // Review the Reader first: do not burn quota on suspect input.
    if (row.flags['品牌货号'] === PINK || (row.flags['采购商品原价'] === PINK && !c['品牌货号'])) { row.notes.push('Look-up held until the reading error is fixed.'); continue; }
    if (ctx.mode === 'round2' && row.skipLookup) continue;
    if (!c['品牌货号'] && !c['品名']) continue;
    if (ctx.lookupsUsed >= MAX_LOOKUPS_PER_RUN) { addFlag(row, '品名', AMBER, 'Look-up deferred: per-run cap reached.'); continue; }
    const req = { brand: c['品牌'], itemId: c['品牌货号'], name: c['品名'], style: row.raw.style, price: c['采购商品原价'], currency: row.raw.currency };
    const res = await ctx.callLookup(req);
    if (!res) continue;
    if (res.paused || res.unavailableReason) {
      // A paused or unavailable look-up stays Amber, even when nothing came back.
      addFlag(row, '品名', AMBER, `Look-up paused: ${res.unavailableReason || 'quota guard reached'}.`);
      ctx.paused.add(res.unavailableReason || 'quota guard');
      if (!res.candidates?.length) continue;
    }
    const top = res.candidates?.[0];
    row.lookup = { cacheKey: res.cacheKey, matchType: top?.matchType || null, confidence: top?.confidence ?? null, sourceUrls: top?.sourceUrls || [] };
    if ((res.candidates || []).some(x => x.matchType === 'price-fallback')) {
      row._candidates = res.candidates.map(x => ({ officialName: x.officialName, itemId: x.itemId, brand: x.brand, price: x.price, currency: x.currency, weightGrams: x.weightGrams, sourceUrls: x.sourceUrls || [] }));
    }
    if (!top) { addFlag(row, '品名', AMBER, 'No official match found; values kept as printed.'); continue; }
    if (top.matchType === 'multi-field') {
      const ties = res.candidates.filter(x => x.matchType === 'multi-field' && x.matchedFields.length === top.matchedFields.length && x.confidence === top.confidence);
      if (ties.length > 1) {
        addFlag(row, '品名', AMBER, 'Several official items match equally well. Pick one.', { candidates: ties.map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, sourceUrls: x.sourceUrls })) });
        continue;
      }
    }
    if (top.matchType === 'price-fallback') {
      const samePrice = res.candidates.filter(x => Math.abs(x.price - top.price) < 0.005);
      if (samePrice.length > 1 && samePrice.every(x => x.weightGrams === null)) {
        addFlag(row, '品名', AMBER, 'Item ID matched nothing; several official items at this price and no published weight. Pick one.', { candidates: samePrice.map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, sourceUrls: x.sourceUrls })) });
        continue;
      }
      row.notes.push(top.weightGrams !== null ? `Closest-price fallback; lightest published weight ${top.weightGrams} g.` : 'Closest-price fallback.');
    }
    // Printed receipt evidence wins on prices and item IDs; look-ups fill names/brands.
    if (!c['品牌'] && top.brand && !ctx.locked(row.rowId, '品牌')) {
      noteMismatch(row, '品牌', c['品牌'], top.brand, 'official');
      c['品牌'] = top.brand;
      addFlag(row, '品牌', AMBER, 'Brand recovered by look-up.', { confidence: top.confidence, sourceUrls: top.sourceUrls });
    }
    if (top.officialName && top.officialName !== c['品名'] && !ctx.locked(row.rowId, '品名')) {
      noteMismatch(row, '品名', c['品名'], top.officialName, 'official');
      row.previousName = c['品名']; c['品名'] = top.officialName;
      addFlag(row, '品名', AMBER, `Official name from look-up (${top.matchType}).`, { confidence: top.confidence, sourceUrls: top.sourceUrls });
    } else if (!ctx.locked(row.rowId, '品名')) addFlag(row, '品名', AMBER, `Confirmed by look-up (${top.matchType}).`, { confidence: top.confidence, sourceUrls: top.sourceUrls });
    // Price columns and 品牌货号 keep the receipt. A different official value is Amber, in a comment, and in the hidden column.
    if (top.price !== null && top.price !== undefined && typeof c['采购商品原价'] === 'number' && Math.abs(Number(top.price) - c['采购商品原价']) > 0.009) {
      for (const col of ['采购商品原价', '采购商品金额']) {
        if (ctx.locked(row.rowId, col)) continue;
        noteMismatch(row, col, c[col], top.price, 'receipt');
        addFlag(row, col, AMBER, `Official price ${top.price} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls });
      }
    }
    if (top.itemId && c['品牌货号'] && String(top.itemId) !== String(c['品牌货号']) && !ctx.locked(row.rowId, '品牌货号')) {
      noteMismatch(row, '品牌货号', c['品牌货号'], top.itemId, 'receipt');
      addFlag(row, '品牌货号', AMBER, `Official item id ${top.itemId} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls });
    }
    if (top.matchType === 'price-fallback') {
      // Price-fallback values are always Amber. The candidate list is hidden metadata.
      if (!ctx.locked(row.rowId, '品名')) addFlag(row, '品名', AMBER, 'Price-fallback look-up.', { candidates: row._candidates });
    }
    row._candidatePrice = top.price; row._candidateCurrency = top.currency;
  }
}

// ---- Stage 3: Reader cross-checks the Look-up Verifier --------------------
function readerReview(rows, trail) {
  for (const row of rows) {
    if (row._candidateCurrency && row.raw.currency && row._candidateCurrency !== row.raw.currency) { row.notes.push(`Official price is in ${row._candidateCurrency}; receipt is ${row.raw.currency}. Printed price kept.`); trail.push({ stage: 'reader-review', rowId: row.rowId, issue: 'currency' }); continue; }
    const p = row.cells['采购商品原价'];
    if (row._candidatePrice && p && Math.abs(row._candidatePrice - p) / p > 0.3 && row.lookup?.matchType === 'id') {
      row.notes.push(`Official price ${row._candidatePrice} differs from printed ${p}; printed price kept.`);
      row.lookup.confidence = Math.max(0, round2((row.lookup.confidence || 0) - 0.2));
      trail.push({ stage: 'reader-review', rowId: row.rowId, issue: 'price-gap' });
    }
  }
}

// ---- Stage 4: Excel Sync & History Manager audit ---------------------------
function excelAudit(rows, ctx) {
  const issues = [];
  for (const row of rows) {
    const c = row.cells;
    if (typeof c['采购商品原价'] === 'number' && c['采购商品原价'] === 0 && row.flags['采购商品原价'] !== PINK) issues.push({ rowId: row.rowId, fix: 'zero-leak' });
    c['销售金额'] = typeof c['采购商品原价'] === 'number' ? round2(c['采购商品原价'] * 0.88) : null;
    if (c['采购时间'] && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c['采购时间'])) issues.push({ rowId: row.rowId, fix: 'timestamp' });
    for (const [col, colour] of Object.entries(row.flags)) {
      if (![PINK, AMBER].includes(colour) || !COLUMNS.includes(col)) issues.push({ rowId: row.rowId, fix: 'bad-flag', col });
      if (ctx.locked(row.rowId, col)) delete row.flags[col]; // human_verified_unflagged: never re-flag
    }
    if (Object.keys(c).join('|') !== COLUMNS.join('|')) issues.push({ rowId: row.rowId, fix: 'columns' });
  }
  return issues;
}
function applyFixes(rows, issues) {
  for (const is of issues) {
    const row = rows.find(r => r.rowId === is.rowId);
    if (!row) continue;
    if (is.fix === 'zero-leak') addFlag(row, '采购商品原价', PINK, 'A 0 price reached the table without a reading flag.');
    if (is.fix === 'timestamp') { addFlag(row, '采购时间', PINK, 'Timestamp not in YYYY-MM-DD HH:MM:SS.'); }
    if (is.fix === 'bad-flag') delete row.flags[is.col];
    if (is.fix === 'columns') row.cells = Object.fromEntries(COLUMNS.map(k => [k, row.cells[k] ?? null]));
  }
}

export async function receiptKeyFor(r, batchId, i) {
  if (r.receiptKey) return String(r.receiptKey);
  if (r.sha256) return 'sha:' + String(r.sha256).slice(0, 16);
  return 'r:' + (await sha256Hex(JSON.stringify([batchId, i, r.merchant, r.receiptReference, r.date, r.time, (r.items || []).length]))).slice(0, 16);
}

export function validateInput(body) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Body must be an object.'), { status: 400 });
  const mode = body.mode || 'round1';
  if (!['round1', 'round2'].includes(mode)) throw Object.assign(new Error('mode must be round1 or round2.'), { status: 400 });
  if (!Array.isArray(body.receipts) || !body.receipts.length) throw Object.assign(new Error('receipts must be a non-empty array.'), { status: 400 });
  if (body.receipts.length > 200) throw Object.assign(new Error('At most 200 receipts per run.'), { status: 400 });
  const batchId = str(body.batchId) || 'b_' + Date.now().toString(36);
  return { batchId, mode, receipts: body.receipts };
}

// Main loop. env gives D1 for locks; deps.lookup can be swapped in tests.
export async function runSanity(env, input, deps = {}) {
  const { batchId, mode } = input;
  const trail = [];
  const locks = new Set();
  // Round 2: persist cleared fills as permanent locks before anything else.
  if (env?.DB) {
    for (const r of input.receipts) for (const it of r.items || []) for (const col of it.clearedCols || []) {
      if (!COLUMNS.includes(col) || !it.rowId) continue;
      await env.DB.prepare('INSERT OR IGNORE INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)').bind(String(it.rowId), col, nowIso()).run();
    }
  }
  const receipts = [];
  for (let i = 0; i < input.receipts.length; i++) {
    const source = input.receipts[i];
    const receiptKey = await receiptKeyFor(source, batchId, i);
    const settled = mode === 'round2' && (source.items || []).length > 0 && (source.items || []).every(it => it.unitSettled || (it.rowId && !(Number(it.qty) > 1)));
    const expanded = expandReceipt({ ...source, receiptKey }, { settled });
    receipts.push({ ...source, receiptKey, items: expanded.items, _unitAudit: expanded.audit, _excludedBySplit: expanded.excludedZero });
  }
  const rowIds = receipts.flatMap(r => (r.items || []).map(it => it.rowId).filter(Boolean));
  if (env?.DB && rowIds.length) {
    for (let k = 0; k < rowIds.length; k += 90) {
      const chunk = rowIds.slice(k, k + 90);
      const res = await env.DB.prepare(`SELECT row_id, col_key FROM human_verified_unflagged WHERE row_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      for (const l of res.results || []) locks.add(`${l.row_id}\u0000${l.col_key}`);
    }
  }
  const memo = new Map();
  const ctx = {
    mode, lookupsUsed: 0, paused: new Set(),
    locked: (rowId, col) => locks.has(`${rowId}\u0000${col}`),
    callLookup: async req => {
      const k = JSON.stringify(req);
      if (memo.has(k)) return memo.get(k);
      ctx.lookupsUsed++;
      let res;
      try { res = await (deps.lookup || defaultLookup)(env, req, deps); } catch (e) { res = { candidates: [], unavailableReason: e.message }; }
      memo.set(k, res);
      return res;
    },
  };
  // Round 2: invalidate cache for edited 品牌货号 and set the skip gate.
  const state = { excludedZero: receipts.flatMap(r => r._excludedBySplit || []) };
  let allRows = [];
  for (const r of receipts) {
    const rows = readerStage(r, 0, state);
    const byId = new Map((r.items || []).filter(it => it.rowId).map(it => [it.rowId, it]));
    const byLine = new Map((r.items || []).map((it, i) => [it.lineIndex ?? i, it]));
    for (const row of rows) {
      const it = byId.get(row.rowId) || byLine.get(row.lineIndex) || {};
      if (mode === 'round2') {
        const edited = new Set(it.editedCols || []);
        if (edited.has('品牌货号') && it.previousItemId) {
          await invalidate(env, { brand: row.cells['品牌'], itemId: row.cells['品牌货号'], previousItemId: it.previousItemId, price: row.cells['采购商品原价'], currency: row.raw?.currency || r.currency });
        }
        const complete = row.cells['品牌'] && row.cells['品名'] && typeof row.cells['采购商品原价'] === 'number';
        const verified = ['品牌', '品名', '采购商品原价'].every(col => !(it.flaggedCols || []).includes(col) || ctx.locked(row.rowId, col) || (it.clearedCols || []).includes(col));
        row.skipLookup = Boolean(complete && verified && !edited.has('品牌货号'));
        row.previous = it.previousCells || null;
        for (const col of it.clearedCols || []) locks.add(`${row.rowId}\u0000${col}`);
      }
    }
    await verifierStage(rows, r, ctx);
    allRows.push(...rows);
  }
  readerReview(allRows, trail);
  let iterations = 0, issues = [];
  do {
    iterations++;
    issues = excelAudit(allRows, ctx);
    trail.push({ stage: 'excel-audit', iteration: iterations, issues: issues.length });
    if (issues.length) applyFixes(allRows, issues);
  } while (issues.length && iterations < MAX_ITERATIONS);
  const finalIssues = excelAudit(allRows, ctx);
  const readingErrors = [], lookupUncertainties = [];
  const agreedRows = allRows.map(row => {
    const round2Changed = row.previous ? COLUMNS.filter(col => row.previous[col] !== undefined && row.previous[col] !== row.cells[col]) : [];
    // Cells the look-up changed in Round 2 are Amber, and never over a human lock.
    if (mode === 'round2') for (const col of round2Changed) {
      if (ctx.locked(row.rowId, col)) { delete row.flags[col]; continue; }
      if (!row.flags[col]) { row.flags[col] = AMBER; row._lookup.push({ col, reason: 'Changed in Round 2.' }); }
    }
    for (const e of row._reading) if (row.flags[e.col]) readingErrors.push({ rowId: row.rowId, col: e.col, reason: e.reason });
    for (const e of row._lookup) if (row.flags[e.col]) lookupUncertainties.push({ rowId: row.rowId, col: e.col, reason: e.reason, confidence: e.confidence ?? row.lookup?.confidence ?? null, sourceUrls: e.sourceUrls || row.lookup?.sourceUrls || [], ...(e.candidates ? { candidates: e.candidates } : {}) });
    const exportMeta = {
      discountKind: row.discountKind || 'none',
      currency: row.raw?.currency || null,
      matchType: row.lookup?.matchType || null,
      confidence: row.lookup?.confidence ?? null,
      sourceUrls: row.lookup?.sourceUrls || [],
      candidates: row._candidates,
      alternates: row._alternates || {},
      comments: row._comments || {},
      officialBranch: row._officialBranch || null,
    };
    return { rowId: row.rowId, receiptKey: row.receiptKey, lineIndex: row.lineIndex, unitIndex: row.unitIndex ?? 0, cells: row.cells, flags: row.flags, notes: row.notes,
      lookup: row.lookup, exportMeta, ...(mode === 'round2' ? { round2Changed } : {}) };
  });
  const result = { agreedRows, excludedZeroCount: state.excludedZero.length, readingErrors, lookupUncertainties, workbookExportReady: finalIssues.length === 0 };
  if (ctx.paused.size) { result.lookupsPaused = true; result.pausedReasons = [...ctx.paused]; }
  return { result, audit: { batchId, mode, iterations, trail, excludedZero: state.excludedZero, lookupsUsed: ctx.lookupsUsed } };
}
