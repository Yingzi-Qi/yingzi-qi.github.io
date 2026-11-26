// Format-only cleanup for exported human-readable text. Semantic mappings such
// as supplier and brand canonicalisation happen in their existing validators.
// Receipt references, item codes, dates, and money are data and keep their
// original representation.
export const HUMAN_TEXT_COLUMNS = Object.freeze(new Set(['供应商', '品牌', '品名', '采购商品方法']));

export function titleCaseWords(value) {
  if (value === null || value === undefined || value === '') return value ?? null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.replace(/\p{L}[\p{L}\p{M}]*/gu, (word, offset, source) => {
    // A possessive suffix is part of the preceding word. Keep its s lower-case
    // while still title-casing each real word after punctuation or a hyphen.
    if ((source[offset - 1] === "'" || source[offset - 1] === '’') && /^s$/iu.test(word)) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

export function formatTextColumn(column, value) {
  return HUMAN_TEXT_COLUMNS.has(column) ? titleCaseWords(value) : value;
}

export function formatVisibleCells(cells) {
  const next = {...(cells || {})};
  for (const column of HUMAN_TEXT_COLUMNS) next[column] = formatTextColumn(column, next[column]);
  return next;
}
