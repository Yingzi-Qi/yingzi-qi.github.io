import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalBrand, normaliseItemId } from './brand-aliases.js';
import { chooseItemId } from './brand-item-ids.js';
import { resolveSupplier } from './uk-branches.js';
import { branchClue, cacheKeys, createLookupClient, parseLookupResponse } from './lookup-client.js';
import { flagColour, parseMismatches, primaryAccess, rankPriceFallback, selectCandidate } from './lookup-match.js';
import { chooseUnitPrice } from './lookup-policy.js';
import { enrichLines } from './lookup-enrich.js';
import { reviewLoop } from './review-loop.js';
import pausedFixture from './lookup-fixtures/paused.json' with { type: 'json' };
import partialFixture from './lookup-fixtures/quota-partial.json' with { type: 'json' };
import lockedFixture from './lookup-fixtures/locked.json' with { type: 'json' };
import branchFixture from './lookup-fixtures/branch-rolex.json' with { type: 'json' };
import miniFixture from './lookup-fixtures/official-mini.json' with { type: 'json' };

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function trackingClient(responder, { maxLookupsPerRun = 60, now, onLocked } = {}) {
  const calls = [];
  const client = createLookupClient({
    baseUrl: 'https://lookup.test',
    maxLookupsPerRun,
    now,
    onLocked,
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      return responder(url, body, calls);
    },
  });
  return { result: client, calls };
}

function line(overrides = {}) {
  return {
    brand: 'Chanel',
    item: 'Mini Flap Bag',
    itemId: 'A01112',
    sku: '',
    qty: 1,
    unitPrice: 5200,
    amount: 5200,
    ...overrides,
  };
}

describe('brand aliases', () => {
  it('expands VCA and collapses Chanel departments', () => {
    assert.equal(canonicalBrand('VCA'), 'Van Cleef & Arpels');
    assert.equal(canonicalBrand('v.c.a.'), 'Van Cleef & Arpels');
    assert.equal(canonicalBrand('Chanel Accessory'), 'Chanel');
    assert.equal(canonicalBrand('CHANEL BOUTIQUE'), 'Chanel');
    assert.equal(canonicalBrand('Bvlgari'), 'Bulgari');
    assert.equal(canonicalBrand('Chanel Beauty UK'), 'Chanel');
  });

  it('does not invent an expansion for an unknown brand', () => {
    assert.equal(canonicalBrand('Morrow'), 'Morrow');
    assert.equal(canonicalBrand(''), '');
  });

  it('keeps leading zeros when normalising an item id', () => {
    assert.equal(normaliseItemId(' ab 0123 '), 'AB0123');
  });
});

describe('response flag', () => {
  it('keeps null and only treats the exact amber hex as a fill', () => {
    assert.equal(parseLookupResponse({ flag: null, candidates: [] }).flag, null);
    assert.equal(parseLookupResponse({ candidates: [] }).flag, null);
    assert.equal(parseLookupResponse({ flag: '', candidates: [] }).flag, '');
    assert.equal(flagColour({ flag: null }), null);
    assert.equal(flagColour({ flag: '' }), null);
    assert.equal(flagColour({}), null);
    assert.equal(flagColour({ flag: '#112233' }), null);
    assert.equal(flagColour({ flag: 'amber' }), null);
    assert.equal(flagColour({ flag: '#FDE68A' }), '#FDE68A');
  });
});

describe('supplier resolution', () => {
  it('uses the department store, not the brand concession', () => {
    const resolved = resolveSupplier({
      merchant: 'Harrods',
      brand: 'Chanel',
      storeClues: { addressLines: ['87-135 Brompton Road'], postcode: 'SW1X 7XL' },
    });
    assert.equal(resolved.kind, 'department-store');
    assert.equal(resolved.supplier, 'Harrods');
  });

  it('uses a brand boutique name, with a branch when that brand has several UK shops', () => {
    const single = resolveSupplier({ merchant: 'Chrome Hearts', brand: 'Chrome Hearts', storeClues: { addressLines: [] } });
    assert.equal(single.supplier, 'Chrome Hearts');
    const branch = resolveSupplier({
      merchant: 'Rolex',
      brand: 'Rolex',
      storeClues: { addressLines: ['Cabot Place'], postcode: 'E14 5AB' },
    });
    assert.equal(branch.supplier, 'Rolex Canary Wharf');
  });

  it('uses the mall when the shop sits inside one', () => {
    const resolved = resolveSupplier({
      merchant: 'Rolex',
      brand: 'Rolex',
      storeClues: { addressLines: ['Bicester Village, 50 Pingle Drive'], postcode: 'OX26 6WD' },
    });
    assert.equal(resolved.kind, 'mall');
    assert.equal(resolved.supplier, 'Bicester Village');
  });

  it('prefers the service branch name for a multi-store boutique', () => {
    const resolved = resolveSupplier({
      merchant: 'Rolex',
      brand: 'Rolex',
      storeClues: { addressLines: [], postcode: '' },
      branch: branchFixture.branch,
    });
    assert.equal(resolved.supplier, 'Rolex Canary Wharf');
  });
});

describe('unit price', () => {
  it('matches the pre-discount unit price, then the paid unit price', () => {
    const both = chooseUnitPrice({ unitPrice: 100, paidUnitPrice: 80, qty: 1 });
    assert.equal(both.price, 100);
    assert.equal(both.field, '采购商品原价');
    const paidOnly = chooseUnitPrice({ paidUnitPrice: 80, qty: 1 });
    assert.equal(paidOnly.price, 80);
    assert.equal(paidOnly.field, '采购商品金额');
    const reversed = chooseUnitPrice({ unitPrice: 100, paidUnitPrice: 80 }, ['paidUnit', 'listUnit']);
    assert.equal(reversed.price, 80);
    assert.equal(reversed.field, '采购商品金额');
  });
});

describe('price fallback ranking', () => {
  const printed = { name: 'Mini flap bag', style: 'A01112', price: 100, currency: 'GBP' };

  it('tier (a) prefers a combined description, item number and price match', () => {
    const ranked = rankPriceFallback([
      { brand: 'Chanel', officialName: 'Classic Wallet', itemId: 'OTHER', price: 100, currency: 'GBP', weightGrams: 50, onOfficialSite: true, matchType: 'price-fallback', matchedFields: ['price'] },
      { brand: 'Chanel', officialName: 'Mini Flap Bag', itemId: 'A01112', price: 102, currency: 'GBP', weightGrams: 300, onOfficialSite: true, matchType: 'price-fallback', matchedFields: ['name', 'style'] },
    ], printed);
    assert.equal(ranked.tier, 'a');
    assert.equal(ranked.winner.officialName, 'Mini Flap Bag');
  });

  it('tier (b) uses an exact price when nothing matches description and item number', () => {
    const ranked = rankPriceFallback([
      { officialName: 'Far Bag', itemId: 'X', price: 90, currency: 'GBP', weightGrams: 10, matchedFields: [] },
      { officialName: 'Exact Bag', itemId: 'Y', price: 100, currency: 'GBP', weightGrams: 90, matchedFields: [] },
    ], { name: 'Unrelated tote', style: '', price: 100, currency: 'GBP' });
    assert.equal(ranked.tier, 'b');
    assert.equal(ranked.winner.officialName, 'Exact Bag');
  });

  it('tier (c) uses the smallest price difference', () => {
    const ranked = rankPriceFallback([
      { officialName: 'Far', itemId: 'X', price: 140, currency: 'GBP', weightGrams: 10, matchedFields: [] },
      { officialName: 'Near', itemId: 'Y', price: 108, currency: 'GBP', weightGrams: 90, matchedFields: [] },
    ], { name: 'Unrelated tote', style: '', price: 100, currency: 'GBP' });
    assert.equal(ranked.tier, 'c');
    assert.equal(ranked.winner.officialName, 'Near');
  });

  it('breaks a close price gap by the lightest published weight', () => {
    const ranked = rankPriceFallback([
      { officialName: 'Heavier', itemId: 'X', price: 101, currency: 'GBP', weightGrams: 500, matchedFields: [] },
      { officialName: 'Lighter', itemId: 'Y', price: 106, currency: 'GBP', weightGrams: 100, matchedFields: [] },
    ], { name: 'Unrelated tote', style: '', price: 100, currency: 'GBP' });
    assert.equal(ranked.winner.officialName, 'Lighter');
  });

  it('does not guess when a close candidate has no published weight', () => {
    const ranked = rankPriceFallback([
      { officialName: 'Heavier', itemId: 'X', price: 102, currency: 'GBP', weightGrams: 400, matchedFields: [] },
      { officialName: 'Unknown', itemId: 'Y', price: 106, currency: 'GBP', weightGrams: null, matchedFields: [] },
    ], { name: 'Unrelated tote', style: '', price: 100, currency: 'GBP' });
    assert.equal(ranked.winner, null);
    assert.equal(ranked.tie, true);
    assert.equal(ranked.weightUnresolved, true);
  });
});

describe('brand item id', () => {
  it('picks the Chanel style ref when a line also prints an EAN and a concession code', () => {
    assert.equal(chooseItemId({
      brand: 'Chanel',
      fields: {
        item: 'Classic flap 999999912345 3607670123456 AS1234 B09876 N1234',
        itemId: '999999912345',
        sku: '3607670123456',
      },
    }), 'AS1234 B09876 N1234');
  });

  it('picks a Prada style ref and a Van Cleef ref from lines with several numbers', () => {
    assert.equal(chooseItemId({
      brand: 'Prada',
      fields: { item: 'Galleria 1BA274 NZV F0002.', itemId: '9999999001234', sku: '8051234567890' },
    }), '1BA274 NZV F0002');
    assert.equal(chooseItemId({
      brand: 'VCA',
      fields: { item: 'Alhambra VCARP7I200', itemId: '999999900111', sku: '3607670123456' },
    }), 'VCARP7I200');
  });

  it('does not use a concession code or an EAN as a Chanel item id', () => {
    assert.equal(chooseItemId({ brand: 'Chanel', fields: { itemId: '9999999001', sku: '3607670123456' } }), '');
    assert.equal(chooseItemId({ brand: 'Other Atelier', fields: { itemId: '3607670123456' } }), '3607670123456');
  });

  it('sends the chosen brand item id on the look-up', async () => {
    const { result, calls } = trackingClient(() => json(miniFixture));
    await enrichLines({
      items: [line({ item: 'mini AS1234 B09876', itemId: '999999912345', sku: '3607670123456' })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(calls[0].body.itemId, 'AS1234 B09876');
    assert.equal(calls[0].body.style, undefined);
  });
});

describe('official-site acceptance', () => {
  it('accepts only an onOfficialSite candidate when a brand is given', () => {
    const selected = selectCandidate([
      { brand: 'Chanel', officialName: 'Retailer Bag', itemId: 'A01112', price: 5200, currency: 'GBP', onOfficialSite: false, matchType: 'id', matchedFields: ['itemId'], sourceUrls: ['https://www.selfridges.com/bag'] },
      { brand: 'Chanel', officialName: 'Mini Flap Bag', itemId: 'A01112', price: 5300, currency: 'GBP', onOfficialSite: true, matchType: 'id', matchedFields: ['itemId'], sourceUrls: ['https://www.chanel.com/bag'] },
    ], { brand: 'Chanel', itemId: 'A01112', name: 'Mini Flap Bag', price: 5200, currency: 'GBP' });
    assert.equal(selected.winner.officialName, 'Mini Flap Bag');
    assert.equal(selected.corroboration.length, 1);
    assert.equal(selected.fallback, false);
  });

  it('tries chanel.com first and does not use chanel.cn when the primary answers', async () => {
    const { result } = trackingClient(() => json({
      ...miniFixture,
      flag: null,
      candidates: [
        {
          ...miniFixture.candidates[0],
          officialName: 'China listing',
          onOfficialSite: false,
          sourceUrls: ['https://www.chanel.cn/gb/fashion/p/A01112/mini-flap-bag'],
        },
        {
          ...miniFixture.candidates[0],
          onOfficialSite: true,
          sourceUrls: ['https://www.chanel.com/gb/fashion/p/A01112/mini-flap-bag'],
        },
      ],
    }));
    const enriched = await enrichLines({ items: [line()], currency: 'GBP', client: result });
    const row = enriched.unitRows[0];
    assert.equal(row.accepted.officialName, 'Mini Flap Bag');
    assert.match(row.accepted.sourceUrls[0], /chanel\.com/);
    assert.equal(row.corroboration.length, 1);
    assert.equal(row.corroboration[0].officialName, 'China listing');
    assert.equal(row.flag, null);
    assert.doesNotMatch(row.reviewNote, /chanel\.cn/);
  });

  it('uses chanel.cn/gb only when chanel.com is blocked and records that note', async () => {
    const page = 'https://www.chanel.cn/gb/fashion/p/A01112/mini-flap-bag';
    const { result } = trackingClient(() => json({
      ...miniFixture,
      flag: null,
      sourceErrors: [{ domain: 'chanel.com', status: 403 }],
      candidates: [{
        ...miniFixture.candidates[0],
        price: 88000,
        currency: 'CNY',
        onOfficialSite: false,
        matchedFields: ['itemId', 'name', 'price'],
        sourceUrls: [page],
      }],
    }));
    const enriched = await enrichLines({ items: [line()], currency: 'GBP', client: result });
    const row = enriched.unitRows[0];
    assert.equal(row.accepted.officialName, 'Mini Flap Bag');
    assert.equal(row.fields['品牌货号'].value, 'A01112');
    assert.equal(row.flag, 'amber');
    assert.equal(row.flagColour, '#FDE68A');
    assert.equal(row.fields['品名'].flag, 'amber');
    assert.match(row.reviewNote, /chanel\.com blocked; confirmed on chanel\.cn\/gb/);
    assert.equal(row.fields['采购商品原价'].value, 5200);
    assert.equal(row.fields['采购商品原价'].flag, null);
    assert.deepEqual(row.fields['采购商品原价'].officialValue, { amount: 88000, currency: 'CNY' });
    assert.equal(row.mismatches.some(entry => entry.field === '采购商品原价'), false);
    const open = selectCandidate([{
      ...miniFixture.candidates[0],
      onOfficialSite: false,
      sourceUrls: [page],
    }], { brand: 'Chanel', itemId: 'A01112', name: 'Mini Flap Bag', price: 5200, currency: 'GBP' });
    assert.equal(open.winner, null);
    const errored = selectCandidate([{
      ...miniFixture.candidates[0],
      price: 1,
      currency: 'CNY',
      onOfficialSite: false,
      sourceUrls: [page],
    }], { brand: 'Chanel', itemId: 'A01112', name: 'Mini Flap Bag', price: 5200, currency: 'GBP' }, {
      primaryBlocked: primaryAccess({ sourceErrors: [{ domain: 'chanel.com', status: 500, error: 'failed' }] }, 'Chanel').blocked,
      blockedDomain: 'chanel.com',
    });
    assert.equal(errored.winner.officialName, 'Mini Flap Bag');
    assert.equal(errored.fallbackNote, 'chanel.com blocked; confirmed on chanel.cn/gb');
  });

  it('does not force Amber when the primary official domain also confirms the candidate', async () => {
    const { result } = trackingClient(() => json({
      ...miniFixture,
      flag: null,
      candidates: [{
        ...miniFixture.candidates[0],
        onOfficialSite: true,
        sourceUrls: [
          'https://www.chanel.com/gb/fashion/p/A01112/mini-flap-bag',
          'https://www.chanel.cn/gb/fashion/p/A01112/mini-flap-bag',
        ],
      }],
    }));
    const enriched = await enrichLines({ items: [line()], currency: 'GBP', client: result });
    const row = enriched.unitRows[0];
    assert.equal(row.accepted.officialName, 'Mini Flap Bag');
    assert.equal(row.flag, null);
    assert.equal(row.fields['品名'].flag, null);
    assert.doesNotMatch(row.reviewNote, /confirmed on chanel\.cn/);
  });

  it('does not let a fallback price decide a match or become a price mismatch', async () => {
    const blocked = { primaryBlocked: true, blockedDomain: 'chanel.com' };
    const { result } = trackingClient(() => json({
      ...miniFixture,
      flag: null,
      sourceErrors: [{ url: 'https://www.chanel.com/gb/fashion', status: 403, error: 'blocked' }],
      mismatches: [{ field: 'price', receiptValue: 5200, officialValue: 100, currency: 'CNY' }],
      candidates: [{
        ...miniFixture.candidates[0],
        price: 100,
        currency: 'CNY',
        onOfficialSite: false,
        matchedFields: ['itemId', 'name', 'price'],
        sourceUrls: ['https://www.chanel.cn/gb/fashion/p/A01112/mini-flap-bag'],
      }],
    }));
    const enriched = await enrichLines({ items: [line()], currency: 'GBP', client: result });
    const row = enriched.unitRows[0];
    assert.equal(row.accepted.officialName, 'Mini Flap Bag');
    assert.equal(row.fields['采购商品原价'].value, 5200);
    assert.equal(row.fields['采购商品原价'].flag, null);
    assert.deepEqual(row.fields['采购商品原价'].officialValue, { amount: 100, currency: 'CNY' });
    assert.equal(row.mismatches.some(entry => entry.field === '采购商品原价'), false);
    const ranked = selectCandidate([
      { brand: 'Chanel', officialName: 'Mirror Bag', itemId: 'A01112', price: 5200, currency: 'GBP', onOfficialSite: false, matchType: 'id', matchedFields: ['itemId', 'price'], sourceUrls: ['https://www.chanel.cn/gb/mirror'] },
      { brand: 'Chanel', officialName: 'Mini Flap Bag', itemId: 'A01112', price: 6000, currency: 'GBP', onOfficialSite: true, matchType: 'id', matchedFields: ['itemId', 'name'], sourceUrls: ['https://www.chanel.com/gb/primary'] },
    ], { brand: 'Chanel', itemId: 'A01112', name: 'Mini Flap Bag', price: 5200, currency: 'GBP' }, blocked);
    assert.equal(ranked.winner.officialName, 'Mini Flap Bag');
  });

  it('does not let a fallback price win a price fallback', () => {
    const ranked = rankPriceFallback([
      { brand: 'Chanel', officialName: 'Mirror exact', itemId: 'M1', price: 100, currency: 'GBP', weightGrams: 50, onOfficialSite: false, matchedFields: ['price'], sourceUrls: ['https://www.chanel.cn/gb/exact'] },
      { brand: 'Chanel', officialName: 'Primary further', itemId: 'P1', price: 140, currency: 'GBP', weightGrams: 200, onOfficialSite: true, matchedFields: [], sourceUrls: ['https://www.chanel.com/gb/further'] },
    ], { brand: 'Chanel', name: 'Unrelated tote', style: '', price: 100, currency: 'GBP' });
    assert.equal(ranked.winner.officialName, 'Primary further');
    const selected = selectCandidate([
      { brand: 'Chanel', officialName: 'Mirror exact', itemId: 'M1', price: 100, currency: 'GBP', weightGrams: 50, onOfficialSite: false, matchType: 'price-fallback', matchedFields: ['price'], sourceUrls: ['https://www.chanel.cn/gb/exact'] },
      { brand: 'Chanel', officialName: 'Primary further', itemId: 'P1', price: 140, currency: 'GBP', weightGrams: 200, onOfficialSite: true, matchType: 'price-fallback', matchedFields: [], sourceUrls: ['https://www.chanel.com/gb/further'] },
    ], { brand: 'Chanel', itemId: 'PRINTED', name: 'Unrelated tote', style: '', price: 100, currency: 'GBP' }, { primaryBlocked: true, blockedDomain: 'chanel.com' });
    assert.equal(selected.winner.officialName, 'Primary further');
  });

  it('rejects a domain that is neither the primary site nor a blocked-site fallback', async () => {
    const { result } = trackingClient(() => json({
      ...miniFixture,
      flag: null,
      candidates: [{
        ...miniFixture.candidates[0],
        onOfficialSite: false,
        sourceUrls: ['https://www.chanel.example/gb/fashion/p/A01112/mini-flap-bag'],
      }],
    }));
    const enriched = await enrichLines({ items: [line()], currency: 'GBP', client: result });
    assert.equal(enriched.unitRows[0].accepted, null);
    assert.equal(enriched.unitRows[0].flag, 'amber');
    assert.equal(enriched.unitRows[0].reason, 'unidentified');
    assert.doesNotMatch(enriched.unitRows[0].reviewNote, /confirmed on/);
  });

  it('flags an official candidate Amber when the printed item id does not identify it', async () => {
    const { result } = trackingClient(() => json({
      ...miniFixture,
      flag: null,
      candidates: [{
        ...miniFixture.candidates[0],
        officialName: 'Other Bag',
        itemId: 'OTHER',
        matchType: 'multi-field',
        matchedFields: ['name'],
      }],
    }));
    const enriched = await enrichLines({ items: [line()], currency: 'GBP', client: result });
    const row = enriched.unitRows[0];
    assert.equal(row.accepted, null);
    assert.equal(row.flag, 'amber');
    assert.equal(row.flagColour, '#FDE68A');
    assert.equal(row.reason, 'unidentified');
  });

  it('does not invent a price fallback when the item id was not confirmed as a miss', () => {
    const selected = selectCandidate([
      { brand: 'Chanel', officialName: 'Other', itemId: 'OTHER', price: 5200, currency: 'GBP', onOfficialSite: true, matchType: 'multi-field', matchedFields: ['price'] },
    ], { brand: 'Chanel', itemId: 'A01112', name: 'Mini', price: 5200, currency: 'GBP' });
    assert.equal(selected.winner, null);
    assert.equal(selected.fallback, false);
  });
});

describe('enrichment', () => {
  it('fills the official name with no colour when the item id and price match the primary site', async () => {
    const { result, calls } = trackingClient(() => json(miniFixture));
    const enriched = await enrichLines({
      items: [line({ item: 'mini' })],
      currency: 'GBP',
      client: result,
    });
    const row = enriched.unitRows[0];
    assert.equal(calls.length, 1);
    assert.equal(row.fields['品名'].value, 'Mini Flap Bag');
    assert.equal(row.fields['品名'].receiptValue, 'mini');
    assert.equal(row.fields['品名'].flag, null);
    assert.equal(row.flag, null);
    assert.equal(row.flagColour, null);
    assert.equal(row.fields['品牌货号'].value, 'A01112');
    assert.equal(row.fields['采购商品原价'].value, 5200);
    assert.equal(row.candidates[0].extra.retailerNote, 'kept as an extra field');
    assert.equal(row.mismatches.some(entry => entry.field === '品名'), false);
  });

  it('records a brand mismatch and outputs the official brand', async () => {
    const { result } = trackingClient(() => json({
      ...miniFixture,
      canonicalBrand: 'Van Cleef & Arpels',
      candidates: [{ ...miniFixture.candidates[0], brand: 'Van Cleef & Arpels' }],
    }));
    const enriched = await enrichLines({
      items: [line({ brand: 'VCA' })],
      currency: 'GBP',
      client: result,
    });
    const row = enriched.unitRows[0];
    const mismatch = row.mismatches.find(entry => entry.field === '品牌');
    assert.equal(row.fields['品牌'].value, 'Van Cleef & Arpels');
    assert.equal(mismatch.receiptValue, 'VCA');
    assert.equal(mismatch.officialValue, 'Van Cleef & Arpels');
    assert.equal(row.fields['品牌'].flag, 'amber');
    assert.equal(row.request.brand, 'VCA');
  });

  it('records a price mismatch and keeps the receipt unit price', async () => {
    const { result } = trackingClient(() => json({
      ...miniFixture,
      candidates: [{ ...miniFixture.candidates[0], officialName: 'Mini Flap Bag', price: 5300 }],
    }));
    const enriched = await enrichLines({
      items: [line({ item: 'Mini Flap Bag', unitPrice: 5200 })],
      currency: 'GBP',
      client: result,
    });
    const row = enriched.unitRows[0];
    const mismatch = row.mismatches.find(entry => entry.field === '采购商品原价');
    assert.equal(row.fields['采购商品原价'].value, 5200);
    assert.equal(mismatch.receiptValue, 5200);
    assert.equal(mismatch.officialValue, 5300);
    assert.equal(row.fields['采购商品原价'].flag, 'amber');
  });

  it('records an item-id mismatch and keeps the printed code', async () => {
    const { result } = trackingClient(() => json({
      cacheHit: false,
      candidates: [{
        brand: 'Chanel', officialName: 'Other Bag', itemId: 'OFFICIAL9', price: 100, currency: 'GBP',
        weightGrams: 200, sourceUrls: ['https://www.chanel.com/other'], onOfficialSite: true,
        matchedFields: ['price'], confidence: 0.4, matchType: 'price-fallback',
      }],
      flag: '#FDE68A', canonicalBrand: 'Chanel', sourcesQueried: ['brave', 'gemini-grounding'],
    }));
    const enriched = await enrichLines({
      items: [line({ item: 'Unrelated tote', itemId: 'PRINTED01', sku: '', unitPrice: 100, amount: 100 })],
      currency: 'GBP',
      client: result,
    });
    const row = enriched.unitRows[0];
    const mismatch = row.mismatches.find(entry => entry.field === '品牌货号');
    assert.equal(row.fields['品牌货号'].value, 'PRINTED01');
    assert.equal(mismatch.receiptValue, 'PRINTED01');
    assert.equal(mismatch.officialValue, 'OFFICIAL9');
    assert.equal(row.flag, 'amber');
    assert.equal(row.candidates.length, 1);
    assert.equal(row.fallbackTier, 'b');
  });

  it('does not flag a row when the receipt already matches the official site', async () => {
    const { result } = trackingClient(() => json(miniFixture));
    const enriched = await enrichLines({
      items: [line()],
      currency: 'GBP',
      client: result,
    });
    const row = enriched.unitRows[0];
    assert.deepEqual(row.mismatches, []);
    assert.equal(row.flag, null);
    assert.equal(row.fields['品牌'].flag, null);
    assert.equal(row.fields['品名'].flag, null);
    assert.equal(row.fields['采购商品原价'].flag, null);
    assert.equal(row.fields['品牌货号'].flag, null);
  });

  it('does not re-flag or rewrite a locked cell', async () => {
    const { result } = trackingClient(() => json(miniFixture));
    const enriched = await enrichLines({
      items: [line({ item: 'mini', locks: { '品名': 'human_verified_unflagged' } })],
      currency: 'GBP',
      client: result,
    });
    const row = enriched.unitRows[0];
    assert.equal(row.fields['品名'].value, 'mini');
    assert.equal(row.fields['品名'].flag, null);
    assert.equal(row.fields['品名'].locked, true);
  });

  it('splits a quantity into unit rows and looks each distinct item up once', async () => {
    const { result, calls } = trackingClient(() => json(miniFixture));
    const enriched = await enrichLines({
      items: [line({ qty: 3, amount: 15600 }), line({ itemId: 'B999', item: 'Other', unitPrice: 10, amount: 10 })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(enriched.unitRows.length, 4);
    assert.equal(enriched.unitRows.filter(row => row.sourceIndex === 0).length, 3);
    assert.equal(new Set(enriched.unitRows.filter(row => row.sourceIndex === 0).map(row => row.fields['品名'].value)).size, 1);
    assert.equal(calls.length, 2);
    assert.equal(enriched.unitRows[1].copied, true);
  });

  it('stops at the run cap and keeps the deferred rows', async () => {
    const { result, calls } = trackingClient(() => json(miniFixture), { maxLookupsPerRun: 2 });
    const enriched = await enrichLines({
      items: [line({ itemId: 'A1' }), line({ itemId: 'A2' }), line({ itemId: 'A3' })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(calls.length, 2);
    assert.equal(enriched.unitRows.length, 3);
    assert.equal(enriched.lookupsDeferred, 1);
    assert.equal(enriched.unitRows[2].deferred, true);
    assert.equal(enriched.unitRows[2].flag, 'amber');
    assert.match(enriched.unitRows[2].reason, /deferred/i);
  });

  it('pauses the rest of the run on a quota response', async () => {
    const { result, calls } = trackingClient(() => json(pausedFixture));
    const enriched = await enrichLines({
      items: [line(), line({ itemId: 'B2' })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(calls.length, 1);
    assert.equal(enriched.lookupsPaused, true);
    assert.ok(enriched.pausedReasons.some(reason => /guard/i.test(reason)));
    assert.equal(enriched.unitRows[0].accepted, null);
    assert.equal(enriched.unitRows[0].flag, 'amber');
    assert.equal(enriched.unitRows[1].deferred, true);
    assert.equal(reviewLoop.lastResult.lookupsPaused, true);
  });

  it('does not price-fallback a partial quota response', async () => {
    const { result, calls } = trackingClient(() => json(partialFixture));
    const enriched = await enrichLines({
      items: [line({ itemId: 'UNKNOWN1', item: 'Unrelated', unitPrice: 100, amount: 100 })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(calls.length, 1);
    assert.equal(enriched.unitRows[0].accepted, null);
    assert.equal(enriched.unitRows[0].flag, 'amber');
    assert.equal(enriched.unitRows[0].candidates.length, 1);
    assert.equal(enriched.lookupsPaused, true);
  });

  it('surfaces an unlock prompt on 401 and does not retry', async () => {
    let prompts = 0;
    const { result, calls } = trackingClient(() => json(lockedFixture, 401), { onLocked: () => { prompts += 1; } });
    const enriched = await enrichLines({
      items: [line(), line({ itemId: 'B2' })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(calls.length, 1);
    assert.equal(prompts, 1);
    assert.equal(enriched.locked, true);
    assert.equal(enriched.unitRows[0].flag, 'amber');
    assert.match(enriched.unitRows[0].reason, /Unlock/i);
    assert.equal(enriched.unitRows[1].deferred, true);
  });

  it('uses the returned branch as the supplier', async () => {
    const { result } = trackingClient(() => json(branchFixture));
    const enriched = await enrichLines({
      merchant: 'Rolex',
      items: [line({ brand: 'Rolex', supplier: 'Rolex' })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(enriched.unitRows[0].fields['供应商'].value, 'Rolex Canary Wharf');
    assert.ok(enriched.unitRows[0].mismatches.some(entry => entry.field === '供应商'));
  });

  it('invalidates an edited item id on round 2 and marks round2Changed', async () => {
    const { result, calls } = trackingClient((url, body) => {
      if (String(url).endsWith('/invalidate')) return json({ invalidated: [{ key: 'lookup:v2:item:chanel:OLD' }] });
      assert.equal(body.bypassCache, true);
      return json({
        ...miniFixture,
        candidates: [{ ...miniFixture.candidates[0], officialName: 'Mini Flap Bag' }],
      });
    });
    const enriched = await enrichLines({
      items: [line({ item: 'mini', itemId: 'A01112' })],
      currency: 'GBP',
      round: 2,
      previous: [{ sourceIndex: 0, '品名': 'mini', '品牌': 'Chanel', '品牌货号': 'OLD', '供应商': '', '采购商品原价': 5200, '采购商品金额': 5200 }],
      editedItemIds: { 0: { previousItemId: 'OLD', itemId: 'A01112' } },
      client: result,
    });
    assert.ok(calls.some(call => call.url.endsWith('/api/lookup/invalidate')));
    assert.deepEqual(calls.find(call => call.url.endsWith('/invalidate')).body, {
      brand: 'Chanel', itemId: 'A01112', previousItemId: 'OLD', name: 'mini', currency: 'GBP', price: 5200,
    });
    assert.ok(enriched.unitRows[0].round2Changed.includes('品名'));
  });

  it('sends store clues on invalidate so the branch cache key is not empty', async () => {
    const { result, calls } = trackingClient((url) => {
      if (String(url).endsWith('/invalidate')) return json({ invalidated: [] });
      return json(miniFixture);
    });
    await enrichLines({
      merchant: 'Rolex',
      items: [line({ brand: 'Rolex', item: 'Datejust', itemId: 'M126234-0018' })],
      currency: 'GBP',
      round: 2,
      storeClues: { addressLines: ['Cabot Place'], postcode: 'E14 5AB', storeNumber: 'CW1' },
      editedItemIds: { 0: { previousItemId: 'OLD', itemId: 'M126234-0018' } },
      client: result,
    });
    const body = calls.find(call => call.url.endsWith('/invalidate')).body;
    assert.equal(body.supplier, 'Rolex');
    assert.equal(body.storeClues.postcode, 'E14 5AB');
    assert.equal(body.storeClues.addressLines[0], 'Cabot Place');
    assert.equal(body.storeClues.storeNumber, 'CW1');
    assert.equal(body.addressLine1, undefined);
    const clue = branchClue(body.storeClues);
    assert.equal(clue, 'E14 5AB');
    assert.equal(cacheKeys.branch(body.supplier, clue), 'lookup:v2:branch:rolex:e14-5ab');
  });

  it('skips a complete verified round 2 row', async () => {
    const { result, calls } = trackingClient(() => json(miniFixture));
    const enriched = await enrichLines({
      items: [line({ verified: { '品牌': true, '品名': true, '采购商品原价': true } })],
      currency: 'GBP',
      round: 2,
      client: result,
    });
    assert.equal(calls.length, 0);
    assert.equal(enriched.unitRows[0].skipped, 'complete-verified');
    assert.equal(enriched.unitRows[0].fields['品牌'].value, 'Chanel');
  });

  it('excludes a confirmed zero and does not search a doubtful zero', async () => {
    const { result, calls } = trackingClient(() => json(miniFixture));
    const enriched = await enrichLines({
      items: [
        line({ unitPrice: 0, amount: 0, zeroConfirmed: true }),
        line({ itemId: 'ZERO2', unitPrice: 0, amount: 0, zeroPrice: 'doubtful' }),
      ],
      currency: 'GBP',
      client: result,
    });
    assert.equal(calls.length, 0);
    assert.equal(enriched.excludedZero.length, 1);
    assert.equal(enriched.unitRows.length, 1);
    assert.equal(enriched.unitRows[0].skipped, 'doubtful-zero');
  });

  it('does not call the service for a fictional sample or a pink item id', async () => {
    const { result, calls } = trackingClient(() => { throw new Error('live search'); });
    const enriched = await enrichLines({
      items: [line(), line({ itemId: 'PINK1' })],
      currency: 'GBP',
      fictionalSample: true,
      client: result,
    });
    assert.equal(calls.length, 0);
    assert.equal(enriched.unitRows.length, 2);
    const pink = await enrichLines({
      items: [line()],
      currency: 'GBP',
      reading: [['itemId']],
      client: result,
    });
    assert.equal(pink.unitRows[0].skipped, 'reading-error');
    assert.equal(calls.length, 0);
  });

  it('sends a raw supplier only when the receipt has one, and omits a missing brand or name', async () => {
    const { result, calls } = trackingClient(() => json({ ...miniFixture, candidates: [] }));
    await enrichLines({
      merchant: 'Chanel Accessory',
      items: [line({ brand: '' })],
      currency: 'GBP',
      client: result,
    });
    assert.equal(calls[0].body.supplier, 'Chanel Accessory');
    assert.equal(calls[0].body.brand, undefined);
    assert.equal(calls[0].body.name, 'Mini Flap Bag');
    const missingName = trackingClient(() => json({ ...miniFixture, candidates: [] }));
    await enrichLines({
      items: [line({ item: '', unitPrice: 5200 })],
      currency: 'GBP',
      client: missingName.result,
    });
    assert.equal(missingName.calls[0].body.name, undefined);
    assert.equal(missingName.calls[0].body.brand, 'Chanel');
    assert.equal(missingName.calls[0].body.itemId, 'A01112');
    assert.equal(Object.hasOwn(missingName.calls[0].body, 'supplier'), false);
  });

  it('dedupes an identical request and remembers a no-match for three days', async () => {
    let clock = Date.parse('2026-11-25T00:00:00Z');
    let fetches = 0;
    const client = createLookupClient({
      baseUrl: 'https://lookup.test',
      now: () => clock,
      fetchImpl: async () => {
        fetches += 1;
        return json({ cacheHit: false, candidates: [], flag: '#FDE68A', sourcesQueried: ['brave', 'gemini-grounding'] });
      },
    });
    const body = { brand: 'Chanel', itemId: 'A01112', price: 10, currency: 'GBP' };
    await client.lookup(body);
    await client.lookup(body);
    assert.equal(fetches, 1);
    clock += 3 * 24 * 60 * 60 * 1000 + 1;
    await client.lookup(body);
    assert.equal(fetches, 2);
  });

  it('merges a top-level mismatch list and ignores a null receipt value', async () => {
    const { result } = trackingClient(() => json({
      ...miniFixture,
      flag: null,
      mismatches: [
        { field: 'brand', receiptValue: 'VCA', officialValue: 'Van Cleef & Arpels' },
        { field: 'name', receiptValue: null, officialValue: 'Should be ignored' },
        { field: 'price', receiptValue: 5200, officialValue: 5300 },
      ],
      candidates: [{ ...miniFixture.candidates[0], brand: 'Van Cleef & Arpels', mismatches: [
        { field: 'itemId', receiptValue: 'A01112', officialValue: 'DIFFERENT' },
      ] }],
    }));
    const enriched = await enrichLines({
      items: [line({ brand: 'VCA' })],
      currency: 'GBP',
      client: result,
    });
    const row = enriched.unitRows[0];
    assert.equal(row.fields['品牌'].value, 'Van Cleef & Arpels');
    assert.equal(row.fields['品牌'].flag, 'amber');
    assert.equal(row.fields['采购商品原价'].value, 5200);
    assert.equal(row.fields['采购商品原价'].officialValue, 5300);
    assert.equal(row.fields['品牌货号'].value, 'A01112');
    assert.equal(row.mismatches.some(entry => entry.officialValue === 'Should be ignored'), false);
    assert.equal(row.mismatches.find(entry => entry.field === '品牌货号').officialValue, 'DIFFERENT');
    assert.equal(row.flagColour, '#FDE68A');
    assert.deepEqual(parseMismatches([{ field: 'name', receiptValue: null, officialValue: 'Mini' }]), []);
  });

  it('pauses the run when only unavailableReason or only quotaGuard is set', async () => {
    const unavailable = trackingClient(() => json({
      cacheHit: false, candidates: [], flag: null, sourcesQueried: [], unavailableReason: 'Both sources are down.',
    }));
    const paused = await enrichLines({
      items: [line(), line({ itemId: 'B2' })],
      currency: 'GBP',
      client: unavailable.result,
    });
    assert.equal(unavailable.calls.length, 1);
    assert.equal(paused.lookupsPaused, true);
    assert.equal(paused.unitRows[1].deferred, true);

    const quota = trackingClient(() => json({
      cacheHit: false, candidates: [], flag: '#FDE68A', sourcesQueried: ['brave'], quotaGuard: ['Brave Search monthly guard reached.'],
    }));
    const guarded = await enrichLines({
      items: [line(), line({ itemId: 'B3' })],
      currency: 'GBP',
      client: quota.result,
    });
    assert.equal(quota.calls.length, 1);
    assert.equal(guarded.lookupsPaused, true);
    assert.equal(guarded.unitRows[0].flag, 'amber');
    assert.equal(guarded.unitRows[1].deferred, true);
  });

  it('puts price in the client cache key only for a price-fallback result', async () => {
    let fetches = 0;
    const client = createLookupClient({
      baseUrl: 'https://lookup.test',
      fetchImpl: async () => {
        fetches += 1;
        return json({
          cacheHit: false,
          candidates: [{ brand: 'Chanel', officialName: 'Bag', itemId: 'OTHER', price: 10, currency: 'GBP', weightGrams: 1, sourceUrls: [], onOfficialSite: true, matchedFields: ['price'], confidence: 0.2, matchType: 'price-fallback' }],
          flag: '#FDE68A',
          sourcesQueried: ['brave'],
        });
      },
    });
    await client.lookup({ brand: 'Chanel', itemId: 'A01112', price: 10, currency: 'GBP' });
    await client.lookup({ brand: 'Chanel', itemId: 'A01112', price: 10, currency: 'GBP' });
    await client.lookup({ brand: 'Chanel', itemId: 'A01112', price: 12, currency: 'GBP' });
    await client.lookup({ brand: 'Chanel', itemId: 'OTHER', price: 12, currency: 'GBP' });
    assert.equal(fetches, 2);
    assert.equal(cacheKeys.item('Van Cleef & Arpels', ' ab 0123 '), 'lookup:v2:item:van-cleef-&-arpels:AB0123');
    assert.equal(cacheKeys.mf('Chanel', 'Mini Bag', 'A01112'), 'lookup:v2:mf:chanel:mini-bag:a01112');
    assert.equal(cacheKeys.pf('Chanel', 'gbp', 10), 'lookup:v2:pf:chanel:GBP:10.00');
    assert.equal(cacheKeys.pf('Chanel', 'GBP', 10).includes('A01112'), false);
    assert.equal(cacheKeys.branch('Rolex', 'E14 5AB'), 'lookup:v2:branch:rolex:e14-5ab');
  });

  it('refuses to call Brave or Gemini from the browser', async () => {
    let fetches = 0;
    const client = createLookupClient({
      baseUrl: 'https://api.search.brave.com',
      fetchImpl: async () => { fetches += 1; return json({}); },
    });
    const result = await client.lookup({ brand: 'Chanel', itemId: 'A1' });
    assert.equal(result.error.code, 'blocked');
    assert.equal(fetches, 0);
  });

  it('treats an uploaded catalogue as corroboration, not an official fill', async () => {
    const enriched = await enrichLines({
      merchant: 'Harrods',
      items: [line({ brand: 'Aster Studio', item: 'Linen tote', itemId: 'AS-028', unitPrice: 34, amount: 34 })],
      orders: [{ retailer: 'Harrods', item_id: 'AS-028', item: 'Linen tote', brand: 'Aster Studio' }],
    });
    assert.equal(enriched.unitRows[0].catalogue.agrees, true);
    assert.equal(enriched.unitRows[0].fields['品名'].value, 'Linen tote');
    assert.equal(enriched.unitRows[0].flag, null);
  });
});
