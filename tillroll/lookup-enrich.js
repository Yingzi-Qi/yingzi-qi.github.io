// Turns receipt lines into one unit row each and fills official brand, name and supplier.
// The receipt stays the source of truth for price and item id. Brand and name take
// the official value when an official-site candidate is accepted. Every difference
// is Amber, with both values kept on the row.

import { canonicalBrand, fold, normaliseItemId } from './brand-aliases.js';
import { resolveSupplier } from './uk-branches.js';
import {
  AMBER, buildLookupRequest, canonicalDisplayBrand, distinctKey, fieldLocked,
  prepareUnitRows, round2Changed, roundMoney, shouldLookup,
} from './lookup-policy.js';
import {
  CLOSE_GAP, computeMismatches, flagColour, mergeMismatches, selectCandidate,
} from './lookup-match.js';
import { recordLookupRun } from './review-loop.js';

export { createLookupClient } from './lookup-client.js';

function differs(field, receipt, official) {
  if (official == null || official === '') return false;
  if (field === '采购商品原价' || field === '采购商品金额') return roundMoney(receipt) !== roundMoney(official);
  if (field === '品牌货号') return normaliseItemId(receipt) !== normaliseItemId(official);
  return fold(receipt) !== fold(official);
}

function cell(field, receiptValue, officialValue, { locked, colour, forceAmber = false, keepReceipt = false } = {}) {
  const hasOfficial = officialValue != null && officialValue !== '';
  const changed = hasOfficial && differs(field, receiptValue, officialValue);
  const value = locked || keepReceipt || !hasOfficial ? (receiptValue ?? '') : officialValue;
  const amber = !locked && (changed || forceAmber);
  return {
    value,
    receiptValue: receiptValue ?? '',
    officialValue: hasOfficial ? officialValue : null,
    flag: amber ? 'amber' : null,
    flagColour: amber ? colour : null,
    locked: Boolean(locked),
  };
}

function catalogueNote(merchant, row, orders) {
  if (!orders?.length || !row.itemId) return null;
  const hits = orders.filter(order =>
    fold(order.retailer) === fold(merchant || row.supplier) &&
    normaliseItemId(order.item_id ?? order.itemId) === normaliseItemId(row.itemId));
  if (hits.length !== 1 && new Set(hits.map(hit => fold(hit.item))).size !== 1) return null;
  const name = String(hits[0].item ?? '').trim();
  return { agrees: fold(name) === fold(row.name), catalogueName: name, source: 'uploaded-catalogue' };
}

function baseFields(row, colour) {
  return {
    '供应商': cell('供应商', row.supplier, null, { colour }),
    '品牌': cell('品牌', row.brand, null, { colour }),
    '品名': cell('品名', row.name, null, { colour }),
    '品牌货号': cell('品牌货号', row.itemId, null, { colour, keepReceipt: true }),
    '采购商品原价': cell('采购商品原价', row.listUnit, null, { colour, keepReceipt: true }),
    '采购商品金额': cell('采购商品金额', row.paidUnit, null, { colour, keepReceipt: true }),
  };
}

function noteFor(result) {
  const parts = [];
  if (result.mirrorNote) parts.push(result.mirrorNote);
  if (result.reason) parts.push(result.reason);
  for (const mismatch of result.mismatches) {
    parts.push(`${mismatch.field}: receipt “${mismatch.receiptValue}”, official “${mismatch.officialValue}”.`);
  }
  if (result.fallbackTier) parts.push(`Price fallback tier ${result.fallbackTier}.`);
  if (result.weightUnresolved) parts.push('No published weight, so no candidate was chosen.');
  if (result.accepted?.sourceUrls?.length) parts.push(`Sources: ${result.accepted.sourceUrls.join(', ')}.`);
  if (result.cacheHit) parts.push('Cache hit.');
  if (result.round2Changed?.length) parts.push(`Round 2 changed ${result.round2Changed.join(', ')}.`);
  return parts.join(' ');
}

function finish(result, row, { response = null, selection = null, orders = null, merchant = '', colour = AMBER, round = 1, previous = null, closeGap: _close = null } = {}) {
  const lockedSkip = result.skipped === 'complete-verified'
    || result.skipped === 'reading-error'
    || result.skipped === 'doubtful-zero';
  const accepted = selection?.winner || null;
  const reported = mergeMismatches(response?.mismatches, accepted?.mismatches);
  const reportedBrand = reported.find(entry => entry.field === '品牌')?.officialValue;
  const reportedName = reported.find(entry => entry.field === '品名')?.officialValue;
  const reportedPrice = reported.find(entry => entry.field === '采购商品原价')?.officialValue;
  const reportedId = reported.find(entry => entry.field === '品牌货号')?.officialValue;
  const officialBrand = reportedBrand || (accepted
    ? (canonicalDisplayBrand(row.brand, response?.canonicalBrand || accepted.brand) || accepted.brand)
    : (lockedSkip ? row.brand : (canonicalBrand(row.brand) || row.brand)));
  const officialName = reportedName || accepted?.officialName || '';
  const officialPrice = reportedPrice != null && reportedPrice !== '' ? reportedPrice : accepted?.price;
  const officialId = reportedId || accepted?.itemId || '';
  const supplier = resolveSupplier({
    merchant: row.supplier || merchant,
    brand: officialBrand || row.brand,
    storeClues: row.storeClues,
    branch: response?.branch || null,
  });
  const mirrorOnly = Boolean(selection?.mirrorOnly);
  const forceName = Boolean(selection?.fallback) || mirrorOnly || result.flag === 'amber' && !accepted && result.queried;
  const fields = {
    '供应商': cell('供应商', row.supplier, supplier.supplier, { locked: fieldLocked(row.locks, '供应商'), colour }),
    '品牌': cell('品牌', row.brand, officialBrand, { locked: fieldLocked(row.locks, '品牌'), colour, forceAmber: mirrorOnly && !fieldLocked(row.locks, '品牌') }),
    '品名': cell('品名', row.name, officialName, { locked: fieldLocked(row.locks, '品名'), colour, forceAmber: forceName && !fieldLocked(row.locks, '品名') }),
    '品牌货号': cell('品牌货号', row.itemId, officialId, {
      locked: fieldLocked(row.locks, '品牌货号'), colour, keepReceipt: true,
    }),
    '采购商品原价': cell('采购商品原价', row.listUnit, row.priceField === '采购商品金额' && reportedPrice == null ? null : officialPrice, {
      locked: fieldLocked(row.locks, '采购商品原价'), colour, keepReceipt: true,
    }),
    '采购商品金额': cell('采购商品金额', row.paidUnit, row.priceField === '采购商品金额' && reportedPrice == null ? officialPrice : null, {
      locked: fieldLocked(row.locks, '采购商品金额'), colour, keepReceipt: true,
    }),
  };
  if (lockedSkip) {
    fields['品牌'] = cell('品牌', row.brand, null, { colour });
    fields['品名'] = cell('品名', row.name, null, { colour });
    fields['供应商'] = cell('供应商', row.supplier, null, { colour });
  }
  const computed = [];
  if (!lockedSkip && (accepted || (officialBrand && fold(officialBrand) !== fold(row.brand)))) {
    computed.push(...computeMismatches(
      { ...row, price: row.price, priceField: row.priceField },
      {
        brand: officialBrand,
        officialName,
        price: accepted?.price,
        currency: accepted?.currency,
        itemId: accepted?.itemId,
      },
    ));
  }
  if (!lockedSkip && fold(supplier.supplier) !== fold(row.supplier)) {
    computed.push({ field: '供应商', receiptValue: row.supplier, officialValue: supplier.supplier });
  }
  result.fields = fields;
  result.mismatches = mergeMismatches(reported, computed);
  result.accepted = accepted;
  result.supplierResolution = supplier;
  result.catalogue = catalogueNote(merchant || row.supplier, row, orders);
  result.weightGrams = selection?.weightUnresolved ? null : (accepted?.weightGrams ?? null);
  result.weightUnresolved = Boolean(selection?.weightUnresolved);
  result.fallbackTier = selection?.fallbackTier || null;
  result.matchType = selection?.matchType || null;
  result.mirrorNote = selection?.mirrorNote || '';
  if (mirrorOnly || selection?.fallback || result.mismatches.length || Object.values(fields).some(entry => entry.flag === 'amber') || forceName) {
    if (!(lockedSkip)) {
      const anyAmber = mirrorOnly || forceName || result.mismatches.some(entry => !fieldLocked(row.locks, entry.field)) || Object.values(fields).some(entry => entry.flag === 'amber');
      if (anyAmber) {
        result.flag = 'amber';
        result.flagColour = colour;
      }
    }
  }
  if (round === 2) result.round2Changed = round2Changed(previous, fields);
  else delete result.round2Changed;
  result.reviewNote = noteFor(result);
  return result;
}

function shell(row) {
  return {
    sourceIndex: row.sourceIndex,
    unitIndex: row.unitIndex,
    unitCount: row.unitCount,
    skipped: null,
    deferred: false,
    queried: false,
    deduped: false,
    copied: false,
    recovery: null,
    request: null,
    cacheHit: null,
    fromClientCache: false,
    matchType: null,
    fallbackTier: null,
    accepted: null,
    candidates: [],
    corroboration: [],
    mismatches: [],
    fields: baseFields(row, AMBER),
    flag: null,
    flagColour: null,
    reviewNote: '',
    reason: '',
    weightGrams: null,
    weightUnresolved: false,
    supplierResolution: null,
    catalogue: null,
    qtyNotSplit: row.qtyNotSplit,
  };
}

function previousFor(previous, sourceIndex) {
  if (!previous) return null;
  if (Array.isArray(previous)) {
    return previous.find(entry => entry && entry.sourceIndex === sourceIndex) || previous[sourceIndex] || null;
  }
  return previous[sourceIndex] || null;
}

function pauseMessage(response) {
  return response?.unavailableReason
    || response?.quotaGuard?.join(' ')
    || response?.error?.message
    || 'Look-up paused.';
}

export async function enrichLines({
  items = [],
  merchant = '',
  currency = '',
  storeClues = null,
  ocrText = '',
  orders = [],
  client = null,
  fictionalSample = false,
  round = 1,
  previous = null,
  locks = [],
  reading = [],
  editedItemIds = {},
  priceFieldOrder,
  closeGap = CLOSE_GAP,
  officialMirrors,
} = {}) {
  const prepared = prepareUnitRows(items, {
    currency, merchant, storeClues, ocrText, priceFieldOrder, reading, locks, editedItemIds,
  });
  const rows = prepared.rows;
  const results = rows.map(shell);
  const groups = new Map();
  rows.forEach((row, index) => {
    const gate = shouldLookup(row, { round, fictionalSample });
    if (!gate.lookup) {
      results[index].skipped = gate.reason;
      results[index].reason = gate.reason === 'fictional-sample' ? '' : gate.reason;
      return;
    }
    const key = distinctKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });

  let lookupsPaused = false;
  const pausedReasons = [];
  let lookupsUsed = 0;
  let lookupsDeferred = 0;
  let locked = false;

  for (const indexes of groups.values()) {
    const primary = rows[indexes[0]];
    const stopped = lookupsPaused || client?.paused || client?.locked;
    if (stopped || !client || typeof client.lookup !== 'function') {
      if (stopped) {
        lookupsDeferred += 1;
        const reason = client?.locked ? 'locked' : 'paused';
        for (const index of indexes) {
          results[index].deferred = true;
          results[index].skipped = reason;
          results[index].reason = pausedReasons.at(-1) || 'Look-up paused.';
          results[index].flag = 'amber';
          results[index].flagColour = AMBER;
        }
      }
      continue;
    }
    if (round === 2 && primary.itemIdEdited && typeof client.invalidate === 'function') {
      const invalidated = await client.invalidate({
        brand: primary.brand,
        itemId: primary.itemId,
        previousItemId: primary.previousItemId,
        name: primary.name,
        style: primary.style,
        supplier: primary.supplier,
        currency: primary.currency,
        price: primary.price,
        postcode: primary.storeClues?.postcode,
        addressLine1: primary.storeClues?.addressLines?.[0],
        storeNumber: primary.storeClues?.storeNumber,
      });
      if (invalidated?.locked) {
        locked = true;
        lookupsPaused = true;
        pausedReasons.push(invalidated.error?.message || 'Unlock Tillroll first.');
      }
    }
    if (lookupsPaused) {
      lookupsDeferred += 1;
      for (const index of indexes) {
        results[index].deferred = true;
        results[index].reason = pausedReasons.at(-1) || 'Look-up paused.';
        results[index].flag = 'amber';
        results[index].flagColour = AMBER;
      }
      continue;
    }
    const built = buildLookupRequest(primary, { bypassCache: round === 2 && primary.itemIdEdited });
    for (const index of indexes) results[index].recovery = built.recovery;
    results[indexes[0]].request = built.body;
    if (!built.body) {
      for (const index of indexes) {
        results[index].reason = built.error || 'too-large';
        results[index].flag = 'amber';
        results[index].flagColour = AMBER;
      }
      continue;
    }
    let response;
    try {
      response = await client.lookup(built.body);
    } catch (error) {
      response = { ok: false, error: { code: 'network', message: String(error?.message || 'Look-up could not be reached.') } };
    }
    const deduped = Boolean(response?.deduped || response?.fromClientCache);
    if (response?.deferred) lookupsDeferred += 1;
    else if (!deduped && !response?.skipped) lookupsUsed += 1;
    const unconfigured = response?.skipped && response.error?.code === 'unconfigured';
    const colour = flagColour(response) || AMBER;
    if (unconfigured) {
      for (const index of indexes) results[index].request = built.body;
      continue;
    }
    const failed = !response?.ok;
    const pausedNow = Boolean(response?.paused || response?.unavailableReason || response?.locked);
    const partial = Array.isArray(response?.quotaGuard) && response.quotaGuard.length > 0;
    let selection = null;
    if (!failed && !pausedNow) {
      selection = selectCandidate(response.candidates, primary, { partial, closeGap, officialMirrors });
    }
    indexes.forEach((index, offset) => {
      const result = results[index];
      result.queried = true;
      result.deduped = offset > 0 || deduped;
      result.copied = offset > 0;
      result.request = built.body;
      result.cacheHit = response?.cacheHit ?? null;
      result.fromClientCache = Boolean(response?.fromClientCache);
      result.candidates = response?.candidates || [];
      result.corroboration = selection?.corroboration || [];
      if (partial && !selection?.winner && !failed && !pausedNow) {
        result.flag = 'amber';
        result.flagColour = colour;
        result.reason = pauseMessage(response);
        result.skipped = 'partial';
      }
      if (failed || pausedNow || response?.deferred) {
        result.deferred = Boolean(response?.deferred || pausedNow);
        result.reason = response?.deferred ? response.error.message : pauseMessage(response);
        result.flag = 'amber';
        result.flagColour = colour;
        result.skipped = response?.locked ? 'locked' : (pausedNow ? 'paused' : (response?.deferred ? 'run-cap' : 'error'));
      }
      finish(result, rows[index], {
        response, selection: failed || pausedNow ? null : selection, orders, merchant, colour, round,
        previous: previousFor(previous, rows[index].sourceIndex), closeGap,
      });
    });
    if (pausedNow || partial || response?.locked || response?.error?.code === '429' || response?.error?.code === '503' || response?.error?.code === 'locked') {
      lookupsPaused = true;
      locked = locked || Boolean(response?.locked || response?.error?.code === 'locked');
      const message = pauseMessage(response);
      if (message && !pausedReasons.includes(message)) pausedReasons.push(message);
    }
  }

  results.forEach((result, index) => {
    if (result.queried) return;
    const colour = AMBER;
    if (result.flag === 'amber' && result.deferred) {
      finish(result, rows[index], {
        orders, merchant, colour, round, previous: previousFor(previous, rows[index].sourceIndex),
      });
      result.flag = 'amber';
      result.flagColour = colour;
      result.fields['品名'].flag = fieldLocked(rows[index].locks, '品名') ? null : 'amber';
      result.fields['品名'].flagColour = result.fields['品名'].flag ? colour : null;
      return;
    }
    finish(result, rows[index], {
      orders, merchant, colour, round, previous: previousFor(previous, rows[index].sourceIndex),
    });
  });

  const snapshot = [];
  const seen = new Set();
  for (const result of results) {
    if (seen.has(result.sourceIndex)) continue;
    seen.add(result.sourceIndex);
    snapshot.push({
      sourceIndex: result.sourceIndex,
      '供应商': result.fields['供应商'].value,
      '品牌': result.fields['品牌'].value,
      '品名': result.fields['品名'].value,
      '品牌货号': result.fields['品牌货号'].value,
      '采购商品原价': result.fields['采购商品原价'].value,
      '采购商品金额': result.fields['采购商品金额'].value,
    });
  }
  const summary = {
    unitRows: results,
    excludedZero: prepared.excludedZero,
    lookupsUsed: client?.lookupsUsed ?? lookupsUsed,
    lookupsDeferred: Math.max(client?.lookupsDeferred ?? 0, lookupsDeferred),
    lookupsPaused,
    pausedReasons,
    locked,
    snapshot,
  };
  recordLookupRun(summary);
  return summary;
}

export async function enrichReceipt(receipt, context = {}) {
  return enrichLines({
    items: receipt?.items || [],
    merchant: receipt?.merchant || '',
    currency: receipt?.currency || '',
    storeClues: receipt?.storeClues || null,
    ...context,
  });
}
