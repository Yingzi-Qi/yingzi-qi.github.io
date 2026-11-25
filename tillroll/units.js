// Shared pure unit-row split. Website Builder owns this module so exporter
// rowIds, D1 locks and Round 2 diffs describe the same unit.
//
// EXPECTED INTERFACE (implemented here because tillroll/units.js was not on
// tillroll-v2-web-backend yet — do not fork a second splitter):
//   joinPurchaseTime(date, time) -> 'YYYY-MM-DD HH:MM:SS' | null
//   expandReceipt(receipt, { settled }?) -> { items, audit, excludedZero }
//   allocateProportional(weightPence, amountPence) -> number[]  // sums exactly; remainder on the last weighted row
//   saleAmount(listPrice) -> number | null     // round(list * 0.88, 2)
//   supplierVisibleName(printed, officialBranch) -> string | null
//   isConfirmedZero(item) -> boolean
//
// One receipt line with qty N becomes N items. 采购商品原价 is the pre-discount
// unit price. 采购商品金额 is the final paid unit price. Line- and receipt-level
// discounts are allocated in proportion to each unit's 原价, in pence, with the
// residual penny on the last weighted row. Printed per-unit discounts are exact
// (discountKind 'printed'). A figure produced by splitting a discount across
// more than one unit is discountKind 'estimated'.
//
// Sales tax added on top of a merchandise subtotal is not spread onto items.
// The paid total the rows must sum to is the merchandise net of discounts.

export const SALE_RATE = 0.88;
export const QTY_CAP = 500;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
export function toPence(n) {
  if (n === null || n === undefined || n === '') return null;
  const x = Number(n);
  return Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 100) : null;
}
export function fromPence(p) { return round2(p / 100); }
export function saleAmount(listPrice) {
  return typeof listPrice === 'number' && Number.isFinite(listPrice) ? round2(listPrice * SALE_RATE) : null;
}

const str = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[£$€,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Same rules the sanity loop already published: 24-hour, seconds 00 if absent.
export function joinPurchaseTime(date, time) {
  const d = str(date);
  if (!d) return null;
  let m = d.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](.+))?$/);
  let Y, M, D, t = str(time);
  if (m) { [, Y, M, D] = m; t = t || m[4] || null; }
  else if ((m = d.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/))) {
    D = m[1].padStart(2, '0'); M = m[2].padStart(2, '0'); Y = m[3].length === 2 ? '20' + m[3] : m[3];
  } else return null;
  if (+M < 1 || +M > 12 || +D < 1 || +D > 31) return null;
  let hh = 0, mm = 0, ss = 0;
  if (t) {
    const tm = String(t).trim().toLowerCase().match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap])?\.?m?\.?/);
    if (!tm) return null;
    hh = +tm[1]; mm = +tm[2]; ss = tm[3] ? +tm[3] : 0;
    if (tm[4] === 'p' && hh < 12) hh += 12;
    if (tm[4] === 'a' && hh === 12) hh = 0;
    if (hh > 23 || mm > 59 || ss > 59) return null;
  }
  const p = n => String(n).padStart(2, '0');
  return `${Y}-${M}-${D} ${p(hh)}:${p(mm)}:${p(ss)}`;
}

export function normaliseQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const r = Math.round(n);
  if (Math.abs(n - r) > 0.001 || r > QTY_CAP) return 1;
  return r;
}

export function isConfirmedZero(item) {
  const unit = num(item?.unitPrice), amount = num(item?.amount);
  const zeroUnit = unit === 0, zeroAmt = amount === 0;
  return (item?.zeroConfirmed === true && (zeroUnit || zeroAmt)) || (zeroUnit && zeroAmt && item?.zeroConfirmed !== false);
}

// Remainder sits on the last row that has weight. Earlier rows are rounded to
// the nearest penny. If that rounding overshoots, pennies are pulled back so
// the shares still sum to amountPence.
export function allocateProportional(weightPence, amountPence) {
  const weights = (weightPence || []).map(w => Math.max(0, Math.trunc(Number(w) || 0)));
  const out = weights.map(() => 0);
  const total = weights.reduce((a, b) => a + b, 0);
  const target = Math.trunc(Number(amountPence) || 0);
  if (target === 0 || total <= 0) return out;
  const capped = Math.min(Math.abs(target), total) * Math.sign(target);
  let last = weights.length - 1;
  while (last > 0 && weights[last] === 0) last--;
  let assigned = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] === 0) continue;
    if (i === last) { out[i] = capped - assigned; continue; }
    const share = Math.round((capped * weights[i]) / total);
    out[i] = share;
    assigned += share;
  }
  if (out[last] < 0) {
    let debt = -out[last];
    out[last] = 0;
    for (let i = last - 1; i >= 0 && debt > 0; i--) {
      const give = Math.min(out[i], debt);
      out[i] -= give;
      debt -= give;
    }
  }
  return out;
}

const closeP = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 2;

// How much receipt-level discount is NOT already inside the line amounts, and
// the merchandise paid total the unit rows must sum to (pence).
export function receiptPaidTarget(linePaidPence, discount, total, subtotal, tax) {
  const sum = linePaidPence.reduce((a, p) => a + (p || 0), 0);
  const discountP = Math.max(0, toPence(discount) || 0);
  const totalP = toPence(total), subP = toPence(subtotal), taxP = toPence(tax) || 0;
  if (discountP > 0) {
    const net = sum - discountP;
    if (closeP(net, totalP)) return { allocate: discountP, expected: totalP, gross: sum };
    if (closeP(net, subP)) return { allocate: discountP, expected: subP, gross: sum };
    if (totalP !== null && taxP && closeP(net + taxP, totalP)) return { allocate: discountP, expected: net, gross: sum };
  }
  return { allocate: 0, expected: sum, gross: sum };
}

function lineFigures(line) {
  const qty = normaliseQty(line?.qty);
  const unit = num(line?.unitPrice);
  const amount = num(line?.amount);
  const each = num(line?.unitDiscount ?? line?.discountEach);
  // A missing unit price of a printed 0 amount stays missing, so a doubtful
  // zero is not turned into a confirmed 0/0 and dropped.
  let list = unit;
  if (list === null && amount !== null && amount !== 0) list = round2(amount / qty);
  let linePaid = amount;
  if (linePaid === null && list !== null) {
    const off = each !== null ? round2(each * qty) : (num(line?.discount) || 0);
    linePaid = round2(list * qty - off);
  }
  return { qty, list, linePaid, each };
}

function unitRowId(receiptKey, lineIndex, unitIndex, explicit, qty) {
  if (explicit && (qty === 1 || /:u\d+$/.test(String(explicit)))) {
    return qty === 1 ? String(explicit) : `${explicit}:u${unitIndex}`;
  }
  return `${receiptKey}:${lineIndex}:u${unitIndex}`;
}

const DEPARTMENT_STORES = [
  'Selfridges', 'Harrods', 'Harvey Nichols', 'Liberty', 'John Lewis', 'Flannels',
  'Fenwick', 'Fortnum & Mason', 'Brown Thomas', 'Galeries Lafayette', 'Saks Fifth Avenue',
  'Nordstrom', 'Neiman Marcus', "Bloomingdale's", 'Printemps', 'KaDeWe', 'El Corte Inglés',
  "Macy's", 'Debenhams', 'House of Fraser', 'Le Bon Marché', 'Bergdorf Goodman',
];
const MALLS = ['Westfield', 'Bluewater', 'Brent Cross', 'Trafford Centre', 'Meadowhall', 'Bullring', 'Liverpool ONE'];
const fold = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
function namedHit(list, value) {
  const f = fold(value);
  if (!f) return null;
  const hits = list.filter(s => f === fold(s) || f.startsWith(fold(s) + ' '));
  hits.sort((a, b) => fold(b).length - fold(a).length);
  return hits[0] || null;
}
export function isDepartmentStore(name) { return Boolean(namedHit(DEPARTMENT_STORES, name)); }
export function isMall(name) { return Boolean(namedHit(MALLS, name)); }

// Department store -> the store name (Harrods, Selfridges). Brand boutique with
// several UK shops -> official branch (Rolex Canary Wharf). Mall -> the mall name.
export function supplierVisibleName(printed, officialBranch) {
  const printedName = str(printed), official = str(officialBranch);
  const dept = namedHit(DEPARTMENT_STORES, printedName) || namedHit(DEPARTMENT_STORES, official);
  if (dept) return dept;
  const mall = namedHit(MALLS, printedName) || namedHit(MALLS, official);
  if (mall) return printedName && fold(printedName).startsWith(fold(mall)) ? printedName : mall;
  if (official && official !== printedName) return official;
  return printedName || official;
}

function copyRound2(line) {
  const out = {};
  for (const k of ['clearedCols', 'flaggedCols', 'editedCols', 'previousCells', 'previousItemId', 'readingFlags', 'fieldIssues', 'zeroConfirmed', 'unitSettled']) {
    if (line[k] !== undefined) out[k] = line[k];
  }
  return out;
}

// settled: items are already one row per unit (a Round 2 upload). Do not split
// again and do not allocate the receipt discount a second time.
export function expandReceipt(receipt, { settled = false } = {}) {
  const lines = Array.isArray(receipt?.items) ? receipt.items : [];
  const receiptKey = str(receipt?.receiptKey) || 'receipt';
  const excludedZero = [];
  if (settled) {
    const items = lines.map((line, i) => {
      const lineIndex = line.lineIndex ?? i;
      const figs = lineFigures({ ...line, qty: 1 });
      const list = figs.list, paid = figs.each !== null && list !== null ? round2(list - figs.each) : (num(line.amount) ?? list);
      const kind = line.discountKind || (list !== null && paid !== null && Math.abs(list - paid) > 0.001 ? 'printed' : 'none');
      return {
        ...line,
        ...copyRound2(line),
        rowId: line.rowId || unitRowId(receiptKey, lineIndex, line.unitIndex || 0, null, 1),
        lineIndex,
        unitIndex: line.unitIndex || 0,
        qty: 1,
        unitPrice: list,
        amount: paid,
        discount: list !== null && paid !== null ? round2(list - paid) : (num(line.discount) || 0),
        discountKind: kind,
        estimated: kind === 'estimated',
        unitSettled: true,
      };
    });
    return { items, excludedZero, audit: auditItems(items, null) };
  }

  const figs = lines.map(lineFigures);
  const payable = figs.map((f, i) => (isConfirmedZero(lines[i]) ? null : f.linePaid));
  const target = receiptPaidTarget(payable.map(p => toPence(p) || 0), receipt?.discount, receipt?.total, receipt?.subtotal, receipt?.tax);

  const drafted = [];
  lines.forEach((line, i) => {
    const lineIndex = line.lineIndex ?? i;
    const f = figs[i];
    if (isConfirmedZero(line)) {
      excludedZero.push({ receiptKey, lineIndex, name: str(line.item) });
      return;
    }
    const listP = toPence(f.list);
    const shares = [];
    for (let u = 0; u < f.qty; u++) {
      const rowId = unitRowId(receiptKey, lineIndex, u, line.rowId, f.qty);
      let paidP = listP;
      let kind = 'none';
      if (f.each !== null && listP !== null) {
        paidP = listP - toPence(f.each);
        kind = 'printed';
      } else if (listP !== null && f.linePaid !== null) {
        const gross = listP * f.qty;
        const net = toPence(f.linePaid);
        if (Math.abs(gross - net) <= 1) paidP = listP;
        else if (f.qty === 1) { paidP = net; kind = 'printed'; }
        else {
          const parts = allocateProportional(Array(f.qty).fill(listP), gross - net);
          paidP = listP - parts[u];
          kind = 'estimated';
        }
      } else if (listP === null && f.linePaid !== null && f.qty === 1) {
        // Printed amount with no unit price (including a doubtful 0). Do not
        // invent a 0 unit price here — that would look like a confirmed zero.
        paidP = toPence(f.linePaid);
      }
      shares.push({ rowId, lineIndex, unitIndex: u, listP, paidP, kind, line });
    }
    drafted.push(...shares);
  });

  if (target.allocate > 0) {
    const weights = drafted.map(d => Math.max(0, d.listP || 0));
    const parts = allocateProportional(weights, target.allocate);
    const weighted = weights.filter(w => w > 0).length;
    drafted.forEach((d, i) => {
      if (!parts[i] || d.paidP === null) return;
      d.paidP -= parts[i];
      d.kind = weighted > 1 ? 'estimated' : (d.kind === 'estimated' ? 'estimated' : 'printed');
    });
  }

  const items = drafted.map(d => {
    const list = d.listP === null ? null : fromPence(d.listP);
    const paid = d.paidP === null ? null : fromPence(d.paidP);
    return {
      ...copyRound2(d.line),
      brand: d.line.brand ?? null,
      item: d.line.item ?? null,
      itemId: d.line.itemId ?? d.line.sku ?? null,
      sku: d.line.sku ?? null,
      colour: d.line.colour ?? null,
      size: d.line.size ?? null,
      rowId: d.rowId,
      lineIndex: d.lineIndex,
      unitIndex: d.unitIndex,
      qty: 1,
      unitPrice: list,
      amount: paid,
      discount: list !== null && paid !== null ? round2(list - paid) : 0,
      discountKind: d.kind,
      estimated: d.kind === 'estimated',
      currency: d.line.currency,
      zeroConfirmed: d.line.zeroConfirmed,
      fieldIssues: d.line.fieldIssues,
      readingFlags: d.line.readingFlags,
    };
  });
  return { items, excludedZero, audit: auditItems(items, target.expected) };
}

function auditItems(items, expectedPence) {
  const priced = items.filter(it => typeof it.amount === 'number');
  const actual = priced.reduce((s, it) => s + (toPence(it.amount) || 0), 0);
  const expected = expectedPence === null || expectedPence === undefined ? actual : expectedPence;
  return {
    ok: actual === expected,
    expected: fromPence(expected),
    actual: fromPence(actual),
    rows: priced.length,
  };
}
