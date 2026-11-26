# Item ID resolution policy

This policy governs how Tillroll identifies a fashion item code printed on a receipt. The extraction stage preserves evidence and proposes candidates. A candidate is exported as the item ID only when deterministic rules select it.

## Candidate record

Each candidate should retain the printed value and provenance in `itemIdCandidates`:

```json
{
  "value": "printed code",
  "class": "product_id | physical_item_id | product_code | sku | style_or_model_reference | serial_number | ean",
  "source": "label | same_line | next_line | chain | barcode",
  "evidence": "short OCR line or geometry reference",
  "confidence": 0.0,
  "checks": {
    "format": "pass | fail | unknown",
    "notDatePricePayment": "pass | fail",
    "gtinChecksum": "pass | fail | not_applicable",
    "brandFormat": "pass | fail | unknown",
    "lookupExact": "pass | fail | unknown",
    "priceWithinTolerance": "pass | fail | unknown"
  },
  "reasons": ["why this candidate was retained or rejected"]
}
```

Raw labelled identifiers remain available in `identifiers`. The candidate list is deduplicated by printed value and class, while leading zeroes are preserved.

## Candidate discovery

1. Read explicit labels such as `ID`, `Item No.`, `Article`, `Product Info`, `Product Code`, `SKU`, `Style`, `Model`, `REF`, `Serial Number`, and `Barcode`.
2. Read an adjoining code on the same product line, the immediately following line, or a contiguous wrapped label/code chain. The code must be spatially or sequentially adjacent to the product name and its price.
3. Retain barcode candidates only when the barcode is read as a code. A 13-digit EAN is classified as `ean`, never silently converted into a brand product code.
4. Ignore candidates that are receipt, transaction, payment, card, merchant, terminal, authorisation, loyalty, telephone, date, quantity, size, tax, discount, total, or price values. Payment and receipt identifiers are never shown as item-ID options.

## Deterministic checks

Candidate scoring is explainable and rule based. Labels identifying a physical item or product ID rank above product code, style/SKU, serial, and EAN. Adjacency to the item name and price, OCR confidence, repeated OCR agreement, a valid GTIN check digit, and a matching brand format add evidence. A candidate loses evidence when it matches an excluded receipt/payment/date/price pattern or conflicts with another candidate.

A server catalogue lookup is exact only when brand and candidate ID match an entry. The lookup may then compare item name and price. Price tolerance is `max(2%, GBP 5)`. A near match or a missing lookup is never used to guess an ID. It is retained with `lookupExact: unknown` or `fail` and sent for review.

## Decision and recovery

`itemIdDecision` records `{ value, status, reason }` where status is:

- `confirmed` when one candidate has explicit deterministic evidence and no conflicting candidate.
- `probable` when one candidate is strongest but an exact catalogue confirmation is still unavailable.
- `ambiguous` when multiple candidates remain plausible or checks conflict.
- `missing` when no safe candidate was found.

Only a confirmed candidate is automatically promoted to `itemId`. A style/model candidate stays in `styleRef`, and an EAN stays in `ean`. Probable, ambiguous, and missing decisions keep all candidates and their reasons visible for human review. If a later OCR pass is required, it may add candidates, but every value must pass the same deterministic checks before promotion.

The policy is versioned with the source code so changes can be reviewed alongside regression tests. Notion may mirror this document later if explicitly authorised, with the repository commit kept as the implementation reference.
