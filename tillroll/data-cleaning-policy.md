# Export text-format policy

The export applies a format-only cleanup to the human-readable text columns
供应商, 品牌, 品名, and 采购商品方法. Each word starts with an uppercase letter
and the remaining letters are lowercase, while punctuation is preserved and
spacing is trimmed and collapsed. For example, `harrods london` becomes
`Harrods London`.

This cleanup does not translate, correct, expand, or replace a word. Existing
supplier, brand, tender, and catalogue validators remain responsible for
semantic normalisation and review flags.

采购小票id, 采购时间, 品牌货号, and numeric money columns keep their exact
validated values. Changing the case of those fields could invalidate receipt
ID formats, catalogue look-ups, dates, or numeric arithmetic.

The same formatter runs in the server sanity result and the workbook writer so
direct exports and server-reviewed exports use the same visible text format.
