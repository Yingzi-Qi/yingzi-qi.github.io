// Whether an unlabelled numeric-only value matches a brand's own item-id
// format. The formats live only in brand-item-ids.js. Labelled concession
// codes, bare 4-digit values, and builder item ids are chosen in export-gate.js.

import { matchesBrandItemId } from './brand-item-ids.js';

export function matchBrandIdFormat(brand, value) {
  return matchesBrandItemId(brand, value) ? 'match' : 'no match';
}
