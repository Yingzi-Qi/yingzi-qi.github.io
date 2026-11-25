// Tillroll v2 — split a printed receipt line into one row per unit.
// Pure ESM, no imports. Safe in the browser and in Cloudflare Pages Functions.
// Excel Sync should reuse this module so export rows line up with agreedRows.
//
// Rules (Yingzi, 25 Nov 2026):
// - Each row is one unit. A qty-N line becomes N rows sharing 采购小票id and 采购时间.
// - 原价 is the pre-discount unit price; 采购商品金额 is the paid unit price;
//   销售金额 = 原价 × 0.88 on each row.
// - The receipt is the source of truth. A printed per-item discount is used
//   exactly. Only when that is not clearly stated is a discount estimated by
//   allocating a line-level or receipt-level total proportionally by 原价,
//   rounded to 2dp with any penny remainder on the last row, and marked
//   { estimated: true } plus Amber #FDE68A.
// - Confirmed true-zero lines must be omitted by the caller; a receipt-level
//   discount is spread only across the non-excluded units they pass in.

export const AMBER = '#FDE68A';

export function round2(n) {
  if (n === null || n === undefined || n === '') return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function unitCount(qty) {
  const n = Number(qty);
  if (Number.isInteger(n) && n > 1) return n;
  return 1;
}

export function unitRowId(receiptKey, lineIndex, unitIndex) {
  return `${receiptKey}:${lineIndex}:${unitIndex}`;
}

function lastWeightedIndex(weights) {
  for (let i = weights.length - 1; i >= 0; i--) if (Number(weights[i]) > 0) return i;
  return Math.max(0, weights.length - 1);
}

// Split `total` across `weights` in proportion to 原价. Parts are 2dp and sum
// exactly to total; leftover pennies go on the last positive-weight row.
export function allocateProportionally(total, weights) {
  const n = weights.length;
  if (!n) return [];
  const cents = Math.round((round2(total) ?? 0) * 100);
  const w = weights.map(x => Number(x) || 0);
  const sumW = w.reduce((a, b) => a + b, 0);
  const parts = Array(n).fill(0);
  if (sumW <= 0) {
    const base = n ? Math.trunc(cents / n) : 0;
    for (let i = 0; i < n; i++) parts[i] = base;
    if (n) parts[n - 1] += cents - base * n;
  } else {
    let used = 0;
    for (let i = 0; i < n; i++) {
      parts[i] = Math.floor((cents * w[i]) / sumW);
      used += parts[i];
    }
    parts[lastWeightedIndex(w)] += cents - used;
  }
  return parts.map(c => round2(c / 100));
}

/** Printed per-item (per-unit) discount, or null if the receipt did not state one clearly. */
export function printedPerItemDiscount(line) {
  const raw = line?.unitDiscount ?? line?.perItemDiscount ?? line?.itemDiscount;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(Math.abs(n)) : null;
}

/** Printed line-level discount total (not per-item), or null if absent. */
export function printedLineDiscount(line) {
  const raw = line?.lineDiscount ?? line?.discount;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(Math.abs(n)) : null;
}

export function printedReceiptDiscount(receipt) {
  const raw = receipt?.receiptDiscount ?? receipt?.discount ?? receipt?.totalDiscount;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(Math.abs(n)) : null;
}

function originalsForLine(line, n) {
  const stated = round2(line.unitPrice);
  if (stated !== null) return Array.from({ length: n }, () => stated);
  const amount = round2(line.amount);
  const lineDisc = printedLineDiscount(line) ?? 0;
  const pre = amount !== null ? round2(amount + lineDisc) : null;
  if (pre === null) return Array.from({ length: n }, () => null);
  return allocateProportionally(pre, Array(n).fill(1));
}

function attachShared(line, unit, receiptKey) {
  const cells = { ...(line.cells || {}) };
  cells['采购商品原价'] = unit.original;
  cells['采购商品金额'] = unit.paid;
  cells['销售金额'] = unit.original !== null ? round2(unit.original * 0.88) : null;
  const flags = { ...(line.flags || {}) };
  if (unit.estimated) flags['采购商品金额'] = AMBER;
  return {
    rowId: unit.rowId,
    receiptKey,
    lineIndex: line.lineIndex,
    unitIndex: unit.unitIndex,
    unitCount: unit.unitCount,
    estimated: unit.estimated,
    cells,
    flags,
    notes: [...(line.notes || [])],
    lookup: line.lookup || null,
    mismatches: line.mismatches || [],
    _reading: [...(line._reading || [])],
    _lookup: [...(line._lookup || [])],
    previous: line.previous || null,
    raw: { ...(line.raw || {}), qty: 1, unitPrice: unit.original, amount: unit.paid, lineDiscount: unit.lineDiscountShare, receiptDiscount: unit.receiptDiscountShare },
  };
}

/**
 * Split the non-excluded printed lines of one receipt into per-unit rows.
 * `lines` must already omit confirmed true-zero items.
 */
export function splitReceiptToUnits(receipt, lines) {
  const receiptKey = receipt?.receiptKey ?? '';
  const prepared = [];
  for (const line of lines || []) {
    if (line && line.unitIndex !== undefined && line.unitIndex !== null && line.alreadyUnit) {
      prepared.push({
        line, n: 1, originals: [line.cells?.['采购商品原价'] ?? round2(line.unitPrice)],
        perItem: printedPerItemDiscount(line), lineDiscount: 0, estimatedLine: false, units: [{ already: true, row: line }],
      });
      continue;
    }
    const n = unitCount(line.qty ?? line.raw?.qty);
    const originals = originalsForLine(line, n);
    const perItem = printedPerItemDiscount(line);
    let lineDiscount = printedLineDiscount(line);
    const amount = round2(line.amount);
    const preTotal = originals.every(v => v !== null) ? round2(originals.reduce((a, b) => a + b, 0)) : null;
    if (lineDiscount === null && perItem === null && amount !== null && preTotal !== null) {
      const implied = round2(preTotal - amount);
      if (implied && implied > 0) lineDiscount = implied;
    }
    prepared.push({ line, n, originals, perItem, lineDiscount: lineDiscount ?? 0, estimatedLine: perItem === null && (lineDiscount ?? 0) > 0 && n > 1 });
  }

  const allUnits = [];
  for (const p of prepared) {
    const shares = p.perItem !== null
      ? Array.from({ length: p.n }, () => p.perItem)
      : (p.lineDiscount > 0 ? allocateProportionally(p.lineDiscount, p.originals.map(v => v ?? 0)) : Array(p.n).fill(0));
    for (let i = 0; i < p.n; i++) {
      allUnits.push({
        prepared: p,
        unitIndex: i,
        unitCount: p.n,
        original: p.originals[i],
        lineDiscountShare: shares[i] ?? 0,
        receiptDiscountShare: 0,
        estimated: Boolean(p.estimatedLine),
        rowId: unitRowId(receiptKey, p.line.lineIndex, i),
      });
    }
  }

  const receiptDiscount = printedReceiptDiscount(receipt);
  if (receiptDiscount && receiptDiscount > 0 && allUnits.length) {
    const weights = allUnits.map(u => u.original ?? 0);
    const shares = allocateProportionally(receiptDiscount, weights);
    allUnits.forEach((u, i) => {
      u.receiptDiscountShare = shares[i] ?? 0;
      u.estimated = true;
    });
  }

  return allUnits.map(u => {
    const paid = u.original === null ? null : round2(u.original - (u.lineDiscountShare || 0) - (u.receiptDiscountShare || 0));
    return attachShared(u.prepared.line, { ...u, paid }, receiptKey);
  });
}

export function splitLineToUnits(line, receipt = {}) {
  const receiptKey = receipt.receiptKey ?? line.receiptKey ?? '';
  return splitReceiptToUnits({ ...receipt, receiptKey }, [{ ...line, lineIndex: line.lineIndex ?? 0 }]);
}
