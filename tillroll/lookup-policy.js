// Gates, unit-row expansion and the request built for POST /api/lookup.
// Price is decided: one output row per unit. 采购商品原价 is the pre-discount unit
// price and is matched first. 采购商品金额 (paid unit) is used only when 原价 is missing.

import { canonicalBrand, fold, normaliseItemId } from './brand-aliases.js';
import { extractStoreClues } from './uk-branches.js';

export const AMBER = '#FDE68A';
export const PRICE_FIELD_ORDER = ['listUnit', 'paidUnit'];
export const OUTPUT_FIELDS = ['供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额'];

export function roundMoney(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[£$€]|\s/g, '').replace(/,(?=\d{3}\b)/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function positiveQty(value) {
  const qty = Number(value);
  return Number.isFinite(qty) && qty > 0 ? qty : null;
}

export function chooseUnitPrice(item, order = PRICE_FIELD_ORDER) {
  const qty = positiveQty(item?.qty) || 1;
  const discount = roundMoney(item?.discount ?? item?.lineDiscount) ?? 0;
  const explicitList = roundMoney(item?.['采购商品原价'] ?? item?.listUnitPrice ?? item?.originalUnitPrice ?? item?.unitPrice);
  const explicitPaid = roundMoney(item?.['采购商品金额'] ?? item?.paidUnitPrice);
  const line = roundMoney(item?.amount);
  const listUnit = explicitList != null ? explicitList : (line == null ? null : roundMoney((line + discount) / qty));
  const paidUnit = explicitPaid != null ? explicitPaid : (line == null ? null : roundMoney(line / qty));
  const values = { listUnit, paidUnit };
  for (const key of order) {
    if (values[key] != null) {
      return {
        price: values[key],
        field: key === 'paidUnit' ? '采购商品金额' : '采购商品原价',
        listUnit,
        paidUnit,
        qty,
      };
    }
  }
  return { price: null, field: null, listUnit, paidUnit, qty };
}

function wholeUnits(value) {
  const qty = Number(value);
  if (!Number.isInteger(qty) || qty < 2 || qty > 99) return 1;
  return qty;
}

function zeroStatus(item, chosen, readingErrors) {
  if (item?.zeroConfirmed === true || item?.zeroPrice === 'confirmed') return 'confirmed';
  if (item?.zeroPrice === 'doubtful' || item?.priceDoubt === true) return 'doubtful';
  if (chosen.price !== 0) return null;
  if (readingErrors?.includes('price') || item?.flags?.price === 'pink') return 'doubtful';
  return 'confirmed';
}

function verifiedComplete(item, chosen) {
  const brand = String(item?.brand ?? item?.['品牌'] ?? '').trim();
  const name = String(item?.item ?? item?.name ?? item?.['品名'] ?? '').trim();
  if (!brand || !name || chosen.price == null) return false;
  if (item?.verified === true || item?.lookupVerified === true) return true;
  const verified = item?.verified || item?.lookupVerified || {};
  const locks = item?.locks || {};
  const ok = key => verified[key] === true || locks[key] === 'human_verified_unflagged';
  return ok('品牌') && ok('品名') && (ok('采购商品原价') || ok(chosen.field) || ok('price'));
}

export function fieldLocked(locks, field) {
  if (!locks) return false;
  if (locks === 'human_verified_unflagged' || locks.all === 'human_verified_unflagged') return true;
  return locks[field] === 'human_verified_unflagged';
}

function clip(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > 200 ? text.slice(0, 200) : text;
}

export function prepareUnitRows(items, { currency = '', merchant = '', storeClues = null, ocrText = '', priceFieldOrder = PRICE_FIELD_ORDER, reading = [], locks = [], editedItemIds = {} } = {}) {
  const clues = extractStoreClues(storeClues, ocrText);
  const rows = [];
  const excludedZero = [];
  (items || []).forEach((item, sourceIndex) => {
    const chosen = chooseUnitPrice(item, priceFieldOrder);
    const readingErrors = [...new Set([...(reading[sourceIndex] || []), ...(item?.readingErrors || [])])];
    const zero = zeroStatus(item, chosen, readingErrors);
    const copies = zero === 'confirmed' ? 1 : wholeUnits(item?.qty);
    const edit = editedItemIds[sourceIndex] || null;
    const rowLocks = locks[sourceIndex] || item?.locks || null;
    for (let unitIndex = 0; unitIndex < copies; unitIndex++) {
      const row = {
        sourceIndex,
        unitIndex,
        unitCount: copies,
        brand: String(item?.brand ?? item?.['品牌'] ?? '').trim(),
        name: String(item?.item ?? item?.name ?? item?.['品名'] ?? '').trim(),
        itemId: String(item?.itemId ?? item?.['品牌货号'] ?? '').trim(),
        style: String(item?.sku ?? item?.style ?? '').trim(),
        currency: String(item?.currency ?? currency ?? '').trim().toUpperCase(),
        supplier: String(item?.supplier ?? item?.['供应商'] ?? merchant ?? '').trim(),
        storeClues: clues,
        price: chosen.price,
        priceField: chosen.field,
        listUnit: chosen.listUnit,
        paidUnit: chosen.paidUnit,
        zero,
        readingErrors,
        locks: rowLocks,
        verifiedComplete: verifiedComplete(item, chosen),
        itemIdEdited: Boolean(edit && String(edit.previousItemId ?? '') !== String(edit.itemId ?? item?.itemId ?? '')),
        previousItemId: edit?.previousItemId ?? '',
        qtyNotSplit: Number(item?.qty) > 99,
      };
      if (zero === 'confirmed') {
        excludedZero.push(row);
        break;
      }
      rows.push(row);
    }
  });
  return { rows, excludedZero };
}

export function shouldLookup(row, { round = 1, fictionalSample = false } = {}) {
  if (fictionalSample) return { lookup: false, reason: 'fictional-sample' };
  if (row.zero === 'doubtful') return { lookup: false, reason: 'doubtful-zero' };
  if (row.readingErrors?.includes('itemId') || row.readingErrors?.includes('price')) {
    return { lookup: false, reason: 'reading-error' };
  }
  if (round === 2 && row.verifiedComplete && !row.itemIdEdited) {
    return { lookup: false, reason: 'complete-verified' };
  }
  if (row.itemId.length > 200) return { lookup: false, reason: 'field-too-long' };
  if (!row.itemId && !row.name && !row.style && row.price == null && !row.supplier) {
    return { lookup: false, reason: 'insufficient-fields' };
  }
  return { lookup: true, reason: '' };
}

export function recoveryMode(row) {
  if (!row.brand) return 'missing-brand';
  if (row.price != null && !row.name) return 'missing-name';
  return 'standard';
}

function cluesForRequest(clues) {
  if (!clues) return null;
  const addressLines = (clues.addressLines || []).map(clip).filter(Boolean).slice(0, 6);
  const postcode = clip(clues.postcode);
  const storeNumber = clip(clues.storeNumber);
  const phone = clip(clues.phone);
  if (!addressLines.length && !postcode && !storeNumber && !phone) return null;
  const body = { addressLines };
  if (postcode) body.postcode = postcode;
  if (storeNumber) body.storeNumber = storeNumber;
  if (phone) body.phone = phone;
  return body;
}

export function buildLookupRequest(row, { bypassCache = false } = {}) {
  const recovery = recoveryMode(row);
  const body = {};
  const brand = clip(row.brand);
  const itemId = clip(row.itemId);
  const name = clip(row.name);
  const style = clip(row.style);
  const supplier = clip(row.supplier);
  if (recovery !== 'missing-brand' && brand) body.brand = brand;
  if (itemId) body.itemId = itemId;
  if (recovery !== 'missing-name' && name) body.name = name;
  if (style) body.style = style;
  if (row.price != null) body.price = roundMoney(row.price);
  if (row.currency) body.currency = clip(row.currency);
  if (supplier) body.supplier = supplier;
  const storeClues = cluesForRequest(row.storeClues);
  if (storeClues) body.storeClues = storeClues;
  if (bypassCache) body.bypassCache = true;
  let json = JSON.stringify(body);
  if (json.length > 20000 && body.storeClues) {
    body.storeClues = { ...body.storeClues, addressLines: [] };
    json = JSON.stringify(body);
  }
  if (json.length > 20000) return { recovery, body: null, error: 'too-large' };
  return { recovery, body, error: '' };
}

export function distinctKey(row) {
  return JSON.stringify({
    brand: fold(row.brand),
    itemId: normaliseItemId(row.itemId),
    name: fold(row.name),
    style: normaliseItemId(row.style),
    price: row.price == null ? null : roundMoney(row.price),
    field: row.priceField,
    currency: row.currency || '',
    supplier: fold(row.supplier),
    postcode: String(row.storeClues?.postcode || '').replace(/\s+/g, '').toUpperCase(),
    storeNumber: fold(row.storeClues?.storeNumber),
  });
}

export function round2Changed(previous, fields) {
  if (!previous) return [];
  return OUTPUT_FIELDS.filter(field => previous[field] !== undefined && previous[field] !== fields[field]?.value);
}

export function canonicalDisplayBrand(printed, serverBrand) {
  if (serverBrand) return canonicalBrand(serverBrand) || String(serverBrand).trim();
  return canonicalBrand(printed) || String(printed ?? '').trim();
}
