// Whether an unlabelled numeric-only 10-digit value matches a brand's own
// item-id format. PR #4 does not keep that table.
//
// TODO: after the rebase onto PR #3, delegate to BRAND_ITEM_ID_FORMATS /
// brandHasItemIdFormat in tillroll/brand-item-ids.js. Until then the answer
// is 'no match', so an unlabelled 10-digit value stays out of 品牌货号.

export function matchBrandIdFormat() {
  return 'no match';
}
