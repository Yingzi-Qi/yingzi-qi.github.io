# Initial receipt reader architecture

This reader is the first stage of Tillroll v2. It produces a small, auditable
receipt record before the larger ten-column export and before any catalogue
enrichment. Its job is to preserve what the receipt says, identify uncertainty,
and provide safe evidence for a later match.

## 1. Pipeline

```text
image
  -> image quality gate
  -> OCR ladder
  -> layout-neutral field extraction
  -> deterministic field validation
  -> exact-price catalogue matching
  -> review gate or initial-reader record
```

The image is addressed by a SHA-256 hash. A repeated hash is a duplicate and
is linked to the first reading instead of creating another purchase. The raw
image stays outside the public repository. The stored reading keeps OCR text,
field evidence, confidence, method, and bounding boxes when available.

The standalone browser entry point is `initial-reader.html`. It runs the
existing local OCR twice, adapts the strict layout result into this contract,
and sends the normalised reading to `POST /api/initial-reader`. GitHub Pages
can still show the local reading when the server endpoint is unavailable.

### Quality gate and OCR ladder

The first pass uses the existing on-device OCR. It is cheap, private, and
available offline. Before parsing, the reader records image dimensions, blur
score, contrast, and crop coverage. A low-quality image, a failed OCR pass, or
an OCR disagreement on a fundamental field is retried with a higher-resolution
crop and then the server OCR endpoint. Server OCR is an extraction aid only.
Its output is sent through the same deterministic validators. If the receipt
still lacks a fundamental, the record is held for human review with the image
and the two readings attached.

The OCR ladder is deliberately bounded. A retry cannot silently turn an
uncertain value into a trusted value. Every retry records its reason and result.

Future purchase dates are blanked with a Pink flag against the processing date.
A later batch-level median rule can add an outlier flag without rewriting the
printed date.

## 2. Initial reader contract

The normalised record has this shape.

```json
{
  "receiptId": "printed receipt identifier or null",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM:SS or null",
  "paymentMethod": "UnionPay | Card | Alipay | WeChat | null",
  "totalPaid": 0,
  "items": [{
    "quantity": 1,
    "itemPrice": 0,
    "purchasePrice": 0,
    "brand": "optional printed brand",
    "name": "optional printed name",
    "reference": "optional printed style/reference"
  }],
  "flags": [],
  "reviewRequired": false,
  "evidence": {"source": "local-ocr", "rawText": "..."}
}
```

`itemPrice` is the printed item price before a discount. `purchasePrice` is
the amount actually paid for that item after an item-level discount. The
reader never fills a missing value from a catalogue result. It may leave an
optional name blank because the reference or brand is enough to search later.

Fundamentals are receipt ID, date, time, payment method, item price, and paid
purchase amount. Missing, conflicting, malformed, or low-confidence
fundamentals become explicit review flags. Supported tender labels are
UnionPay, Card, Alipay, and WeChat. Apple Pay and Google Pay are normalised to
Card. A split or repeated tender is retained as a `split_payment` flag until a
human confirms how the total should be attributed.

The reader recognises item lines only when a line has a positive price and at
least one item clue such as a reference, name, or brand. Footer totals, tax,
tender, change, staff, rewards, policy, and address lines are never promoted to
items by this stage.

## 3. Deterministic match service

The server matcher receives the normalised reading and rows from the approved
catalogue table. The matcher itself does not call an LLM, OCR service, or web
search. It scores reference, brand, and name clues, but price is a hard
acceptance key. When the D1 table has no candidate, the endpoint may optionally
ask the existing official-domain lookup service for discovery candidates. Those
results still pass through this matcher and remain review-only unless the same
price, clue, and official-source rules succeed.

1. A catalogue row is an accepted exact match only when its currency and price
   equal the receipt item price to the cent and at least one clue agrees.
2. Among exact-price rows, the highest deterministic clue score wins only when
   it is unique. A tie remains `review` with all candidates recorded.
3. If no exact-price row exists, the service returns a review-only nearest
   candidate. It first prefers the smallest absolute price gap, then a
   candidate at or above the receipt price, then the lightest published weight. This is
   evidence for a human and never changes the receipt's price or identity.
4. If no candidate has a usable clue, the service reports `no_match` even when
   a same-price catalogue row exists. A missing exact catalogue row is Amber
   with the reason `No exact catalogue match in the server lookup table.`

An accepted match records the official brand, official name, official
reference, exact catalogue price, official URL, retrieval timestamp, matching
clues, and deterministic confidence. The receipt values remain alongside the
official evidence so an official page cannot overwrite the source document.
For known brands, the URL must belong to the brand's approved official domain.
An unknown catalogue brand is accepted only from an HTTPS source loaded by an
operator-approved catalogue. A reseller URL remains review evidence.

## 4. Persistence and recovery

Cloudflare D1 stores one reading, its item lines, match candidates, and review
events. The image hash links repeated uploads to the first reading, while a
receipt ID seen on another image creates a duplicate-conflict review event. A
failed write is retried idempotently using those keys. The
raw image is linked by an external image URL or local object key and is never
copied into git.

Review is required for a missing fundamental, unsupported tender, split
payment, duplicate conflict, an ambiguous exact-price match, an absent exact
catalogue row, or an OCR retry that still disagrees. A review action records
the field changed, the old evidence, the new value, the operator, and time.

## 5. Operational checks

Synthetic tests cover complete readings, missing fundamentals, split tenders,
OCR disagreement, exact-price matching, price mismatch, candidate ties, and
the more-expensive/lighter fallback rule. Production metrics should report
duplicate rate, fundamental-review rate, exact-match rate, no-match rate,
average OCR retries, and manual corrections by field. These metrics identify
which layout or OCR fallback needs improvement without changing deterministic
business rules.
