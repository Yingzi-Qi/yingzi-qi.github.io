// Server-side review loop behind /api/sanity-run. Encodes the Operating Manual
// roles (Reader & Sanity Checker -> Look-up Verifier -> Reader cross-check ->
// Excel Sync audit) and iterates until the audit converges. Only the final
// agreed version leaves this module; the internal trail is stored in D1 only.
import { canonicalBrand } from './brands.js';
import { lookup as defaultLookup, invalidate } from './lookup.js';
import { nowIso, sha256Hex } from './http.js';
import { expandReceipt, isConfirmedZero, joinPurchaseTime, supplierVisibleName } from '../../../tillroll/units.js';

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
// P4, with the 25 Nov wallet decision. Card schemes map to Card with no fill.
// A wallet with a scheme printed also maps to Card with no fill. A wallet with
// no scheme maps to Card and is Pink, pending owner confirmation. Cash and an
// empty tender stay as printed or empty and are Pink.
export const ALLOWED_TENDERS = ['UnionPay', 'Card', 'Alipay', 'WeChat'];
export const TENDER_REASON = 'Payment method must be UnionPay, Card, Alipay or WeChat.';
export const WALLET_REASON = 'wallet, scheme not printed';
const SCHEME = /\b(visa|mastercard|master\s*card|maestro|amex|american express|debit|credit|card)\b/i;
const WALLET = /\b(apple\s*pay|google\s*pay|samsung\s*pay|garmin\s*pay|android\s*pay|wallet)\b/i;
const CHANEL_BLOCKED_COMMENT = 'chanel.com blocked; confirmed on chanel.cn/gb';
export function normaliseTender(p) {
  const s = str(p);
  if (!s) return null;
  if (/union\s*pay/i.test(s)) return 'UnionPay';
  if (/ali\s*pay/i.test(s)) return 'Alipay';
  if (/we\s*chat|wechat/i.test(s)) return 'WeChat';
  if (SCHEME.test(s) || WALLET.test(s)) return 'Card';
  return s;
}
export function walletWithoutScheme(original) {
  const s = str(original);
  return Boolean(s) && WALLET.test(s) && !SCHEME.test(s) && !/union\s*pay/i.test(s);
}
function itemIdKind(id) {
  const s = String(id ?? '').replace(/[\s-]/g, '');
  if (!s) return 'empty';
  if (/^9999999\d*$/.test(s)) return 'concession';
  if (/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s)) return 'ean';
  return 'style';
}
function idsMatch(a, b) {
  const n = v => String(v ?? '').replace(/[\s-]/g, '').toUpperCase();
  return Boolean(n(a)) && n(a) === n(b);
}
function exactIdAndPrice(top, row) {
  const price = row.cells['采购商品原价'];
  if (top?.matchType !== 'id' || typeof price !== 'number' || top.price == null) return false;
  if (top.currency && row.raw?.currency && top.currency !== row.raw.currency) return false;
  return Math.abs(Number(top.price) - price) < 0.009;
}
function touchCell(row, col) {
  if (!row._lookupTouched) row._lookupTouched = new Set();
  row._lookupTouched.add(col);
}
function appendComment(row, col, text) {
  if (!text) return;
  if (!row._comments) row._comments = {};
  const cur = row._comments[col];
  if (!cur) row._comments[col] = text;
  else if (!cur.includes(text)) row._comments[col] = `${cur}; ${text}`;
}
function chanelFallbackComment(urls) {
  const parsed = [];
  for (const u of urls || []) { try { parsed.push(new URL(u)); } catch { /* not a URL */ } }
  if (!parsed.length) return null;
  const host = u => u.hostname.replace(/^www\./i, '').toLowerCase();
  const cnOrGb = u => host(u) === 'chanel.cn' || host(u).endsWith('.chanel.cn') || (host(u) === 'chanel.com' && u.pathname.toLowerCase().startsWith('/gb'));
  const otherChanel = u => host(u) === 'chanel.com' && !u.pathname.toLowerCase().startsWith('/gb');
  if (!parsed.some(cnOrGb) || parsed.some(otherChanel)) return null;
  return CHANEL_BLOCKED_COMMENT;
}

function addFlag(row, col, colour, reason, extra = {}) {
  const prev = row.flags[col];
  // Mixed reading + look-up uncertainty is Amber (manual 7E.19).
  row.flags[col] = prev && prev !== colour ? AMBER : colour;
  (colour === PINK ? row._reading : row._lookup).push({ col, reason, ...extra });
}
// A look-up on this row produced a new result for this cell. Round 2 may replace the baseline flag.
function lookupFlag(row, col, colour, reason, extra = {}) {
  if (!row._lookupTouched) row._lookupTouched = new Set();
  row._lookupTouched.add(col);
  addFlag(row, col, colour, reason, extra);
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
    if (confirmedZero) { state.excludedZero.push(zeroRecord(receipt.receiptKey, it, lineIndex, receipt)); return; }
    const brandRaw = str(it.brand);
    const row = { rowId: it.rowId || `${receipt.receiptKey}:${lineIndex}:u0`, receiptKey: receipt.receiptKey, lineIndex, unitIndex: it.unitIndex ?? 0, flags: {}, notes: [], _reading: [], _lookup: [], _alternates: {}, _comments: {}, _candidates: null, _officialBranch: null, lookup: null, discountKind: it.discountKind || 'none',
      cells: { '采购小票id': receiptId, '采购时间': ts, '供应商': merchant, '品牌': brandRaw, '品名': str(it.item), '品牌货号': stripBrandFromItemId(it.itemId ?? it.sku, brandRaw),
        '采购商品原价': unit ?? (amount !== null ? round2((amount + discount) / (qty || 1)) : null), '采购商品金额': amount, '采购商品方法': tender, '销售金额': null },
      raw: { style: str(it.sku) !== str(it.itemId) ? str(it.sku) : null, colour: str(it.colour), size: str(it.size), qty, currency: str(receipt.currency) || 'GBP' },
      storeClues: receipt.storeClues || null };
    if (!receiptId) addFlag(row, '采购小票id', PINK, /selfridges/i.test(merchant || '') ? 'Selfridges receipt number (below the barcode) not read.' : /harrods/i.test(merchant || '') ? 'Harrods receipt number (right of date/time) not read.' : 'Receipt ID not read.');
    if (!ts) addFlag(row, '采购时间', PINK, 'Date/time missing or not a valid date.');
    if (!merchant) addFlag(row, '供应商', PINK, 'Supplier not read.');
    if (walletWithoutScheme(receipt.payment)) {
      addFlag(row, '采购商品方法', PINK, WALLET_REASON, { pendingOwnerConfirmation: true });
      row._comments['采购商品方法'] = WALLET_REASON;
    } else if (!tender || !ALLOWED_TENDERS.includes(tender)) {
      addFlag(row, '采购商品方法', PINK, TENDER_REASON);
      row._comments['采购商品方法'] = TENDER_REASON;
    }
    if (!row.cells['品名'] || JUNK_NAME.test(row.cells['品名'])) addFlag(row, '品名', PINK, `Item name "${row.cells['品名'] ?? ''}" failed the column sanity check.`);
    const idp = itemIdProblem(row.cells['品牌货号']);
    if (idp) addFlag(row, '品牌货号', PINK, `Item ID ${idp}.`);
    if ((it.fieldIssues || []).some(f => /itemid/i.test(f))) addFlag(row, '品牌货号', PINK, 'Reader marked the item ID as uncertain.');
    if (unit === null && amount === null) addFlag(row, '采购商品原价', PINK, 'No price read.');
    else if (unit === null) addFlag(row, '采购商品原价', PINK, 'Unit price not printed; derived from line amount.');
    if ((zeroUnit || zeroAmt) && row.flags['采购商品原价'] !== PINK) addFlag(row, '采购商品原价', PINK, 'Doubtful 0 price: may be an OCR miss.');
    if (amount === null) addFlag(row, '采购商品金额', PINK, 'Line amount not read.');
    else if (unit !== null && Math.abs(qty * unit - discount - amount) > 0.02 && Math.abs(qty * unit - amount) > 0.02) addFlag(row, '采购商品金额', PINK, `qty × unit price − discount (${round2(qty * unit - discount)}) does not match amount (${amount}).`);
    for (const col of it.readingFlags || []) if (COLUMNS.includes(col)) addFlag(row, col, PINK, it.baselineFlagReasons?.[col] || it.flagReasons?.[col] || 'Flagged by the reader.');
    // Printed per-unit discounts are exact. Only a proportional estimate is Amber.
    if (it.discountKind === 'estimated' && typeof row.cells['采购商品金额'] === 'number') {
      addFlag(row, '采购商品金额', AMBER, 'Discount allocated proportionally from a line or receipt total (not printed per unit).');
    }
    rows.push(row);
  });
  return rows;
}

function candidateText(list) {
  if (!list?.length) return '';
  return 'Candidates: ' + list.map(c => [c.officialName, c.itemId, c.price].filter(v => v != null && v !== '').join(' ')).join(' | ');
}
// Store-internal means the 9999999… concession family. No other pattern is
// defined; a numeric style ref such as 000001 stays a style ref.
function settleBrandItemId(row, top, ctx) {
  const c = row.cells;
  if (ctx.locked(row.rowId, '品牌货号')) return;
  const printed = row.raw.printedItemId ?? c['品牌货号'];
  const kind = itemIdKind(printed);
  const styleId = itemIdKind(top?.itemId) === 'style' ? String(top.itemId).trim() : null;
  if (kind === 'concession') {
    if (itemIdKind(c['品牌货号']) === 'concession') c['品牌货号'] = null;
    if (styleId && top) {
      c['品牌货号'] = styleId;
      row._alternates['品牌货号'] = { receipt: printed, official: styleId, shown: 'official' };
      row._comments['品牌货号'] = `Concession code ${printed} is not a brand item id. Official item id ${styleId}.`;
      if (top.matchType === 'price-fallback') appendComment(row, '品牌货号', candidateText(row._candidates?.length ? row._candidates : [top]));
      if (row.flags['品牌货号'] === PINK) {
        delete row.flags['品牌货号'];
        row._reading = row._reading.filter(e => e.col !== '品牌货号');
      }
      lookupFlag(row, '品牌货号', AMBER, 'Official brand item id from look-up.', { sourceUrls: top.sourceUrls || [], ...(row._candidates ? { candidates: row._candidates } : {}) });
    } else if (row.flags['品牌货号'] !== PINK) {
      c['品牌货号'] = null;
      appendComment(row, '品牌货号', printed);
      appendComment(row, '品牌货号', 'no brand item ID printed');
      addFlag(row, '品牌货号', PINK, 'no brand item ID printed');
      row._alternates['品牌货号'] = { receipt: printed, official: null, shown: 'receipt' };
    } else {
      c['品牌货号'] = null;
      appendComment(row, '品牌货号', printed);
      if (!row._alternates['品牌货号']) row._alternates['品牌货号'] = { receipt: printed, official: null, shown: 'receipt' };
    }
    return;
  }
  if (row.flags['品牌货号'] === PINK) return;
  if (kind === 'ean') {
    if (styleId && !idsMatch(styleId, printed)) {
      noteMismatch(row, '品牌货号', printed, styleId, 'official');
      c['品牌货号'] = styleId;
      if (top?.matchType === 'price-fallback') appendComment(row, '品牌货号', candidateText(row._candidates?.length ? row._candidates : [top]));
      lookupFlag(row, '品牌货号', AMBER, 'Style reference used instead of an EAN.', { sourceUrls: top?.sourceUrls || [] });
    } else if (printed) {
      appendComment(row, '品牌货号', 'Only an EAN is available; the brand item id was not found.');
      if (!row._alternates['品牌货号']) row._alternates['品牌货号'] = { receipt: printed, official: null, shown: 'receipt' };
      lookupFlag(row, '品牌货号', AMBER, 'Only an EAN is available; the brand item id was not found.', { sourceUrls: top?.sourceUrls || [] });
    }
    return;
  }
  if (kind === 'style' && top?.matchType === 'price-fallback') {
    if (top.itemId && printed && !idsMatch(top.itemId, printed)) {
      noteMismatch(row, '品牌货号', printed, top.itemId, 'receipt');
      lookupFlag(row, '品牌货号', AMBER, `Official item id ${top.itemId} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls || [], ...(row._candidates ? { candidates: row._candidates } : {}) });
    } else if (printed) {
      lookupFlag(row, '品牌货号', AMBER, 'Price-fallback look-up.', { sourceUrls: top.sourceUrls || [], ...(row._candidates ? { candidates: row._candidates } : {}) });
    }
    appendComment(row, '品牌货号', candidateText(row._candidates?.length ? row._candidates : [top]));
    return;
  }
  if (top?.itemId && printed && !idsMatch(top.itemId, printed) && top.matchType !== 'price-fallback') {
    noteMismatch(row, '品牌货号', printed, top.itemId, 'receipt');
    lookupFlag(row, '品牌货号', AMBER, `Official item id ${top.itemId} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls || [] });
  }
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
      lookupFlag(row, '供应商', AMBER, 'Official UK branch name from look-up.', { sourceUrls: res.branch.sourceUrls || [] });
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
        lookupFlag(row, '品牌', AMBER, 'Brand expanded to the official name.');
      }
    }
    // Review the Reader first: do not burn quota on suspect input.
    row.raw.printedItemId = c['品牌货号'];
    if (row.flags['品牌货号'] === PINK || (row.flags['采购商品原价'] === PINK && !c['品牌货号'])) { row.notes.push('Look-up held until the reading error is fixed.'); settleBrandItemId(row, null, ctx); continue; }
    if (ctx.mode === 'round2' && row.skipLookup) { settleBrandItemId(row, null, ctx); continue; }
    if (!row.raw.printedItemId && !c['品名']) { settleBrandItemId(row, null, ctx); continue; }
    if (ctx.lookupsUsed >= MAX_LOOKUPS_PER_RUN) { lookupFlag(row, '品名', AMBER, 'Look-up deferred: per-run cap reached.'); settleBrandItemId(row, null, ctx); continue; }
    const req = { brand: c['品牌'], itemId: row.raw.printedItemId, name: c['品名'], style: row.raw.style, price: c['采购商品原价'], currency: row.raw.currency };
    const res = await ctx.callLookup(req);
    if (!res) { settleBrandItemId(row, null, ctx); continue; }
    if (res.paused || res.unavailableReason) {
      // A paused or unavailable look-up stays Amber, even when nothing came back.
      lookupFlag(row, '品名', AMBER, `Look-up paused: ${res.unavailableReason || 'quota guard reached'}.`);
      ctx.paused.add(res.unavailableReason || 'quota guard');
      if (!res.candidates?.length) { settleBrandItemId(row, null, ctx); continue; }
    }
    const top = res.candidates?.[0];
    row.lookup = { cacheKey: res.cacheKey, matchType: top?.matchType || null, confidence: top?.confidence ?? null, sourceUrls: top?.sourceUrls || [] };
    if ((res.candidates || []).some(x => x.matchType === 'price-fallback')) {
      row._candidates = res.candidates.map(x => ({ officialName: x.officialName, itemId: x.itemId, brand: x.brand, price: x.price, currency: x.currency, weightGrams: x.weightGrams, sourceUrls: x.sourceUrls || [] }));
    }
    if (!top) { lookupFlag(row, '品名', AMBER, 'No official match found; values kept as printed.'); settleBrandItemId(row, null, ctx); continue; }
    if (top.matchType === 'multi-field') {
      const ties = res.candidates.filter(x => x.matchType === 'multi-field' && x.matchedFields.length === top.matchedFields.length && x.confidence === top.confidence);
      if (ties.length > 1) {
        lookupFlag(row, '品名', AMBER, 'Several official items match equally well. Pick one.', { candidates: ties.map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, sourceUrls: x.sourceUrls })) });
        settleBrandItemId(row, top, ctx); continue;
      }
    }
    if (top.matchType === 'price-fallback') {
      const samePrice = res.candidates.filter(x => Math.abs(x.price - top.price) < 0.005);
      if (samePrice.length > 1 && samePrice.every(x => x.weightGrams === null)) {
        lookupFlag(row, '品名', AMBER, 'Item ID matched nothing; several official items at this price and no published weight. Pick one.', { candidates: samePrice.map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, sourceUrls: x.sourceUrls })) });
        settleBrandItemId(row, top, ctx); continue;
      }
      row.notes.push(top.weightGrams !== null ? `Closest-price fallback; lightest published weight ${top.weightGrams} g.` : 'Closest-price fallback.');
    }
    // P5: an exact item-id and price match writes the official 品名 with no fill.
    // Amber is only for a partial match, a price-fallback, or no identified item.
    // A Pink reading flag on any other cell is left in place. A lock is not overwritten.
    const exact = exactIdAndPrice(top, row);
    if (exact) row._exactIdPrice = true;
    if (!c['品牌'] && top.brand && !ctx.locked(row.rowId, '品牌')) {
      noteMismatch(row, '品牌', c['品牌'], top.brand, 'official');
      c['品牌'] = top.brand;
      lookupFlag(row, '品牌', AMBER, 'Brand recovered by look-up.', { confidence: top.confidence, sourceUrls: top.sourceUrls });
    }
    if (!ctx.locked(row.rowId, '品名') && row.flags['品名'] !== PINK) {
      if (top.officialName && top.officialName !== c['品名']) {
        noteMismatch(row, '品名', c['品名'], top.officialName, 'official');
        row.previousName = c['品名'];
        c['品名'] = top.officialName;
      }
      if (exact) {
        touchCell(row, '品名');
        if (row.flags['品名'] === AMBER) delete row.flags['品名'];
      } else {
        const why = top.matchType === 'price-fallback' ? 'Price-fallback look-up.'
          : top.matchType === 'id' ? 'Item id matched but the price does not match the official site exactly.'
          : `Partial or unidentified look-up (${top.matchType}).`;
        lookupFlag(row, '品名', AMBER, why, { confidence: top.confidence, sourceUrls: top.sourceUrls, ...(row._candidates ? { candidates: row._candidates } : {}) });
      }
    }
    if (top.price !== null && top.price !== undefined && typeof c['采购商品原价'] === 'number' && Math.abs(Number(top.price) - c['采购商品原价']) > 0.009) {
      for (const col of ['采购商品原价', '采购商品金额']) {
        if (ctx.locked(row.rowId, col)) continue;
        noteMismatch(row, col, c[col], top.price, 'receipt');
        lookupFlag(row, col, AMBER, `Official price ${top.price} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls });
      }
    }
    settleBrandItemId(row, top, ctx);
    if (canonicalBrand(c['品牌']) === 'Chanel') {
      const note = chanelFallbackComment(top.sourceUrls || []);
      if (note) for (const col of ['品名', '品牌', '品牌货号']) if (c[col]) appendComment(row, col, note);
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
// Round 2 keeps every baseline flag. A flag changes only when a person cleared
// the fill, edited the value, or a look-up of this row produced a new result
// for that cell. A cleared fill is a lock and is never put back.
function restoreBaselineFlags(row, ctx) {
  const base = row._baselineFlags;
  if (!base) return;
  const edited = row._editedCols || new Set();
  const cleared = row._clearedCols || new Set();
  const touched = row._lookupTouched || new Set();
  for (const col of COLUMNS) {
    const locked = cleared.has(col) || ctx.locked(row.rowId, col);
    if (locked) { delete row.flags[col]; continue; }
    if (edited.has(col) || touched.has(col)) continue;
    const was = base[col];
    if (was === PINK || was === AMBER) {
      if (row.flags[col] === was) continue;
      row.flags[col] = was;
      const reason = row._baselineFlagReasons?.[col] || 'Kept from the previous export.';
      const list = was === PINK ? row._reading : row._lookup;
      if (!list.some(e => e.col === col)) list.push({ col, reason });
    } else if (was === null && Object.prototype.hasOwnProperty.call(base, col)) {
      delete row.flags[col];
    }
  }
}

function zeroRecord(receiptKey, it, i, receipt) {
  const printedId = str(it?.receiptId) || str(it?.['采购小票id']) || str(receipt?.receiptReference) || str(receipt?.orderNumber) || str(receipt?.orderId);
  const printedTime = str(it?.purchaseTime) || str(it?.['采购时间']);
  const purchaseTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(printedTime || '')
    ? printedTime
    : normaliseTimestamp(printedTime || receipt?.date, printedTime ? null : receipt?.time);
  return {
    receiptKey: it.receiptKey || receiptKey, lineIndex: it.lineIndex ?? i, name: str(it.item) || str(it.name),
    qty: num(it.qty), unitPrice: num(it.unitPrice), amount: num(it.amount),
    reason: it.reason || 'Confirmed printed zero.',
    receiptId: printedId, purchaseTime,
  };
}
function dedupeZero(list) {
  const seen = new Set();
  return list.filter(z => {
    const key = `${z.receiptKey}|${z.lineIndex}|${z.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    for (const it of expanded.items) {
      const src = (source.items || []).find((line, i) => (line.lineIndex ?? i) === it.lineIndex);
      if (src?.flagReasons) it.flagReasons = { ...src.flagReasons, ...it.flagReasons };
    }
    const fromItems = settled ? [] : (source.items || []).flatMap((it, i) => isConfirmedZero(it) ? [zeroRecord(receiptKey, it, i, source)] : []);
    const fromPayload = Array.isArray(source.excludedZero) ? source.excludedZero.map(z => zeroRecord(z.receiptKey || receiptKey, z, z.lineIndex ?? 0, source)) : [];
    receipts.push({ ...source, receiptKey, items: expanded.items, _unitAudit: expanded.audit, _excludedBySplit: expanded.excludedZero, _carriedZero: fromItems.length ? fromItems : fromPayload });
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
  const state = { excludedZero: receipts.flatMap(r => (r._carriedZero && r._carriedZero.length) ? r._carriedZero : (r._excludedBySplit || [])) };
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
        row._baselineFlags = it.baselineFlags || null;
        row._baselineFlagReasons = it.baselineFlagReasons || {};
        row._editedCols = edited;
        row._clearedCols = new Set(it.clearedCols || []);
        row._baselineConfidence = it.baselineConfidence ?? null;
        row._baselineSourceUrls = it.baselineSourceUrls || [];
        row._baselineMatchType = it.baselineMatchType || null;
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
      // P5: an exact item-id and price match leaves 品名 with no fill, even when the official name changed.
      if (col === '品名' && row._exactIdPrice) continue;
      if (!row.flags[col]) { row.flags[col] = AMBER; row._lookup.push({ col, reason: 'Changed in Round 2.' }); }
    }
    if (row._exactIdPrice && row.flags['品名'] === AMBER && !ctx.locked(row.rowId, '品名')) delete row.flags['品名'];
    if (mode === 'round2') restoreBaselineFlags(row, ctx);
    const flagReasons = {};
    const pendingOwnerConfirmation = {};
    for (const e of row._reading) if (row.flags[e.col]) flagReasons[e.col] = e.reason;
    for (const e of row._lookup) if (row.flags[e.col]) flagReasons[e.col] = e.reason;
    for (const e of [...row._reading, ...row._lookup]) if (e.pendingOwnerConfirmation && row.flags[e.col]) pendingOwnerConfirmation[e.col] = true;
    for (const e of row._reading) if (row.flags[e.col]) readingErrors.push({ rowId: row.rowId, col: e.col, reason: e.reason });
    for (const e of row._lookup) if (row.flags[e.col]) lookupUncertainties.push({ rowId: row.rowId, col: e.col, reason: e.reason, confidence: e.confidence ?? row.lookup?.confidence ?? null, sourceUrls: e.sourceUrls || row.lookup?.sourceUrls || [], ...(e.candidates ? { candidates: e.candidates } : {}) });
    const exportMeta = {
      discountKind: row.discountKind || 'none',
      currency: row.raw?.currency || 'GBP',
      matchType: row.lookup?.matchType || row._baselineMatchType || null,
      confidence: row.lookup?.confidence ?? row._baselineConfidence ?? null,
      sourceUrls: (row.lookup?.sourceUrls && row.lookup.sourceUrls.length) ? row.lookup.sourceUrls : (row._baselineSourceUrls || []),
      candidates: row._candidates,
      alternates: row._alternates || {},
      comments: row._comments || {},
      officialBranch: row._officialBranch || null,
      flagReasons,
      pendingOwnerConfirmation: Object.keys(pendingOwnerConfirmation).length ? pendingOwnerConfirmation : null,
      storeClues: row.storeClues || null,
    };
    return { rowId: row.rowId, receiptKey: row.receiptKey, lineIndex: row.lineIndex, unitIndex: row.unitIndex ?? 0, cells: row.cells, flags: row.flags, flagReasons, notes: row.notes,
      lookup: row.lookup, exportMeta, ...(mode === 'round2' ? { round2Changed } : {}) };
  });
  state.excludedZero = dedupeZero(state.excludedZero);
  const result = { agreedRows, excludedZero: state.excludedZero, excludedZeroCount: state.excludedZero.length, readingErrors, lookupUncertainties, workbookExportReady: finalIssues.length === 0 };
  if (ctx.paused.size) { result.lookupsPaused = true; result.pausedReasons = [...ctx.paused]; }
  return { result, audit: { batchId, mode, iterations, trail, excludedZero: state.excludedZero, lookupsUsed: ctx.lookupsUsed } };
}
