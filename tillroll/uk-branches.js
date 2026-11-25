// Decided 25 Nov 2026: 供应商 is the largest enclosing shop, not the brand concession.
// A department store stays the department store. A brand's own boutique keeps the
// brand, plus a branch when that brand has several UK shops. A shop inside a mall
// uses the mall name. storeClues (and an API branch, when one was returned) are the
// only inputs — a street is never invented from the merchant string alone.

import { canonicalBrand, fold } from './brand-aliases.js';

const DEPARTMENT_STORES = [
  {
    name: 'Harrods',
    names: ['harrods'],
    multiStore: false,
    branches: [],
  },
  {
    name: 'Selfridges',
    names: ['selfridges', 'selfridge'],
    multiStore: true,
    branches: [
      { suffix: 'London Oxford Street', postcode: /^W1[AU]/i, streets: ['oxford street'] },
      { suffix: 'Manchester Trafford', postcode: /^M17/i, streets: ['trafford'] },
      { suffix: 'Manchester Exchange Square', postcode: /^M3/i, streets: ['exchange square'] },
      { suffix: 'Birmingham', postcode: /^B5/i, streets: ['bullring'] },
    ],
  },
  {
    name: 'Harvey Nichols',
    names: ['harvey nichols'],
    multiStore: true,
    branches: [
      { suffix: 'Knightsbridge', postcode: /^SW1X/i, streets: ['knightsbridge', 'brompton road'] },
    ],
  },
  {
    name: 'Liberty',
    names: ['liberty', 'liberty london'],
    multiStore: false,
    branches: [],
  },
  {
    name: 'Fortnum & Mason',
    names: ['fortnum and mason', 'fortnum mason'],
    multiStore: false,
    branches: [],
  },
  {
    name: 'John Lewis',
    names: ['john lewis'],
    multiStore: true,
    branches: [],
  },
  {
    name: 'Flannels',
    names: ['flannels'],
    multiStore: true,
    branches: [],
  },
];

const BRAND_BOUTIQUES = [
  {
    name: 'Rolex',
    names: ['rolex'],
    multiStore: true,
    branches: [
      { suffix: 'Canary Wharf', postcode: /^E14/i, streets: ['canada place', 'cabot place', 'canary wharf'] },
    ],
  },
  {
    name: 'Chrome Hearts',
    names: ['chrome hearts'],
    multiStore: false,
    branches: [],
  },
  {
    name: 'Chanel',
    names: ['chanel'],
    multiStore: true,
    branches: [
      { suffix: 'New Bond Street', postcode: /^W1S/i, streets: ['new bond street'] },
      { suffix: 'Sloane Street', postcode: /^SW1X9/i, streets: ['sloane street'] },
    ],
  },
];

const MALLS = [
  { name: 'Bicester Village', pattern: /bicester village/i },
  { name: 'Westfield London', pattern: /westfield london/i },
  { name: 'Westfield Stratford City', pattern: /westfield stratford/i },
  { name: 'Bluewater', pattern: /bluewater/i },
  { name: 'Brent Cross', pattern: /brent cross/i },
  { name: 'Meadowhall', pattern: /meadowhall/i },
  { name: 'Trafford Centre', pattern: /trafford centre/i },
];

export function normalisePostcode(value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, '');
}

function clueText(storeClues) {
  const clues = storeClues || {};
  return [
    clues.mall,
    clues.postcode,
    clues.storeNumber,
    ...(Array.isArray(clues.addressLines) ? clues.addressLines : []),
  ].filter(Boolean).join('\n');
}

function findMall(merchant, storeClues) {
  const explicit = String(storeClues?.mall ?? '').trim();
  if (explicit) {
    const known = MALLS.find(mall => mall.pattern.test(explicit));
    return known ? known.name : explicit;
  }
  const haystack = `${merchant || ''}\n${clueText(storeClues)}`;
  return MALLS.find(mall => mall.pattern.test(haystack))?.name || '';
}

function matchChain(chains, value) {
  const folded = fold(canonicalBrand(value) || value);
  if (!folded) return null;
  return chains.find(chain => chain.names.some(name => folded === name || folded.startsWith(name + ' '))) || null;
}

function branchFromClues(chain, storeClues) {
  if (!chain?.multiStore || !chain.branches.length) return '';
  const postcode = normalisePostcode(storeClues?.postcode);
  const lines = (storeClues?.addressLines || []).map(fold);
  const storeNumber = fold(storeClues?.storeNumber);
  if (postcode) {
    const hits = chain.branches.filter(branch => branch.postcode.test(postcode));
    if (hits.length === 1) return hits[0].suffix;
    if (hits.length > 1) return '';
  }
  if (storeNumber) {
    const hits = chain.branches.filter(branch => (branch.storeNumbers || []).some(number => fold(number) === storeNumber));
    if (hits.length === 1) return hits[0].suffix;
  }
  const streetHits = chain.branches.filter(branch =>
    branch.streets.some(street => lines.some(line => line.includes(street))));
  return streetHits.length === 1 ? streetHits[0].suffix : '';
}

function officialBranchName(chain, branch) {
  const official = String(branch?.officialStoreName ?? '').trim();
  if (!official || branch?.unavailable) return '';
  if (!chain) return '';
  return fold(official).includes(fold(chain.name)) ? official : '';
}

function withBranch(chain, storeClues, branch) {
  const fromApi = officialBranchName(chain, branch);
  if (fromApi) return { name: fromApi, branchResolved: true };
  const suffix = branchFromClues(chain, storeClues);
  if (!suffix) return { name: chain.name, branchResolved: false };
  return { name: `${chain.name} ${suffix}`, branchResolved: true };
}

export function resolveSupplier({ merchant = '', brand = '', storeClues = null, branch = null } = {}) {
  const printed = String(merchant || '').trim();
  const mall = findMall(printed, storeClues);
  if (mall) {
    return { supplier: mall, kind: 'mall', branchResolved: true, printed };
  }
  const department = matchChain(DEPARTMENT_STORES, printed);
  if (department) {
    const resolved = withBranch(department, storeClues, branch);
    return { supplier: resolved.name, kind: 'department-store', branchResolved: resolved.branchResolved, printed };
  }
  const boutique = matchChain(BRAND_BOUTIQUES, printed) || (printed ? null : matchChain(BRAND_BOUTIQUES, brand));
  if (boutique) {
    const resolved = withBranch(boutique, storeClues, branch);
    if (!printed && !resolved.branchResolved) {
      return { supplier: '', kind: 'store', branchResolved: false, printed: '' };
    }
    return { supplier: resolved.name, kind: 'boutique', branchResolved: resolved.branchResolved, printed: printed || boutique.name };
  }
  const named = canonicalBrand(printed) || printed;
  return { supplier: named, kind: 'store', branchResolved: false, printed };
}

export function extractStoreClues(explicit, ocrText = '') {
  const given = explicit && typeof explicit === 'object' ? explicit : {};
  const lines = Array.isArray(given.addressLines) ? given.addressLines.map(line => String(line).trim()).filter(Boolean) : [];
  const text = String(ocrText || '');
  const postcode = String(given.postcode || '').trim() || (text.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i)?.[1] || '');
  const phone = String(given.phone || '').trim() || (text.match(/\b(?:\+44\s?|0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/)?.[0] || '');
  const storeNumber = String(given.storeNumber || '').trim()
    || (text.match(/\b(?:store|branch|shop)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{1,12})\b/i)?.[1] || '');
  if (!lines.length && postcode) {
    const source = text.split(/\n/).map(line => line.trim()).filter(Boolean);
    const found = source.find(line => line.toUpperCase().includes(postcode.toUpperCase().replace(/\s+/g, '')) || line.toUpperCase().includes(postcode.toUpperCase()));
    if (found) lines.push(found);
  }
  return {
    addressLines: lines.slice(0, 6),
    postcode: postcode.toUpperCase().replace(/\s+/g, ' ').trim(),
    storeNumber,
    phone,
    ...(given.mall ? { mall: String(given.mall).trim() } : {}),
  };
}
