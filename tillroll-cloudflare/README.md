# Tillroll v2 — Cloudflare Pages backend (free tier only)

Static UI: `../tillroll` (unchanged GitHub Pages mirror keeps working; v2 controls hide themselves on `github.io`).
Backend: Pages Functions in `functions/`, D1 schema in `migrations/`, config in `wrangler.toml`.
Owner: Website Builder. Source of truth: Notion "Tillroll v2 — Operating Manual" (sections 2, 4.5, 7E).

## Cloudflare resources (account yingzi.qi04@gmail.com, free plan)
| Resource | Name | ID |
| --- | --- | --- |
| D1 | `tillroll-v2-db` (WEUR) | `0dc9556b-4d50-41e2-a004-554b083cec81` |
| KV | `tillroll-v2-lookup-cache` | `50b5636d24974dcfa8da87711f0359de` |
| Pages project | `tillroll-v2` → `https://tillroll-v2.pages.dev` | not created yet (see Deploy) |

## Endpoints (same-origin `/api/*`)
| Method & path | Purpose |
| --- | --- |
| `POST /api/lookup` | KV/D1-cached Brave Search + Gemini grounding proxy (binding contract below) |
| `POST /api/lookup/invalidate` | `{brand,itemId,previousItemId?,price?,currency?}`: drop cache for an edited 品牌货号 |
| `POST /api/sanity-run` | `{batchId,receipts,mode:"round1"|"round2"}` → `{runId,batchId,status,pollAfterMs}` (202) |
| `GET /api/sanity-run/:runId` | `queued|running|completed|failed`; completed returns ONLY `{agreedRows,excludedZeroCount,readingErrors,lookupUncertainties,workbookExportReady}` |
| `GET /api/quota` | quota-guard status, `lookupsPaused` + Amber flag |
| `POST /api/ocr` | Gemini Vision proxy (server key, daily guard, backoff) |
| `POST /api/initial-reader` | Deterministic first-reader contract. Accepts OCR fields, validates receipt fundamentals, matches each item against the D1 catalogue by exact price plus a clue, and returns official evidence or review-only candidates. |
| `POST /api/batches` | SHA-256 duplicate check + batch registration |
| `GET/POST /api/history` | Reading History |
| `GET/POST /api/locks` | `human_verified_unflagged` locks |
| `GET /api/workbooks`, `POST /api/workbooks/:id/refresh` | Linked Workbooks; refresh streams the Drive file to the browser refresh flow |
| `GET /api/auth/google`, `GET /api/auth/google/callback`, `GET /api/auth/session`, `POST /api/auth/logout`, `POST /api/auth/unlock` | Google OAuth (`drive.file`), session, passcode gate |
| `GET /api/drive/files?folder=exports|history`, `GET /api/drive/files/:id`, `POST /api/drive/upload?name=&folder=&batchId=` | Drive storage adapter (`Tillroll/Exports`, `Tillroll/History`) |
| `GET /api/health` | bindings/secrets present (booleans only) |

### `/api/lookup` (Orchestrator, 25 Nov 2026)
Request `{brand,itemId,name,style,price,currency,storeClues:{addressLines,postcode,storeNumber,phone},bypassCache?}`.
Response `{cacheHit,cacheKey,sourcesQueried,candidates:[{brand,officialName,itemId,price,currency,weightGrams,sourceUrls,onOfficialSite,matchedFields,confidence,matchType}]}`.
Keys (30-day TTL): `lookup:v2:item:{brand}:{itemId}`, `lookup:v2:mf:{brand}:{name}:{style}`, `lookup:v2:pf:{brand}:{currency}:{price.toFixed(2)}` (only when itemId matched nothing), `lookup:v2:branch:{supplier}:{postcode|addressLine1|storeNumber}`.
Brand given ⇒ only `onOfficialSite` candidates (verified against the brand's official domain by code, not by the model). Retailers only corroborate.
Additive fields (proposed, see PR): `supplier` (request), `branch`, `printedItemId`, `canonicalBrand`, `flag`, `paused`, `unavailableReason`, `quotaGuard` (response).

### `/api/initial-reader`

The browser sends the output of the existing local or fallback server OCR as
`{reading:{receiptId,date,time,paymentMethod,totalPaid,items:[{itemPrice,purchasePrice,brand,name,reference}],evidence}}`.
The endpoint never asks an AI model to validate a value. It blanks ambiguous
fundamentals, flags split tenders and total mismatches, and keeps the image
hash idempotent. An accepted item match requires an exact catalogue price, at
least one matching clue, and an official source URL. If those conditions are
not met, the endpoint returns review-only candidates ordered by closest price,
then a price at or above the receipt amount, then lighter published weight.
Receipt values are preserved separately from the official brand, name,
reference, price, and source URL evidence. Run migration `0003_initial_reader.sql`
before using the endpoint in a bound D1 environment.

### Excel export and Update/Refresh (Excel Sync, 25 Nov 2026)
The workbook is built in the browser (`tillroll/v2-excel.js` + `tillroll/units.js`). No new credentials.

Visible columns, in order: `采购小票id`, `采购时间`, `供应商`, `品牌`, `品名`, `品牌货号`, `采购商品原价`, `采购商品金额`, `采购商品方法`, `销售金额`. `销售金额` is the number `round(原价 × 0.88, 2)`, never a formula. Fills are only Pink `#FECDD3` and Amber `#FDE68A` (header fill `#1E4946` is not a flag). Hidden columns: Tillroll row id, receipt key, source URLs, confidence, match type, original values (baseline JSON), price-fallback candidates, other values (receipt vs official).

One receipt line with quantity N is N rows. Printed per-unit discounts are copied exactly. A line- or receipt-level discount is split in proportion to each unit's 原价 (pence, remainder on the last weighted row) and that paid cell is Amber. Department-store `供应商` is the store name; a brand boutique uses the official branch; a mall keeps the mall name.

Refresh (the Linked Workbooks button, or a v2 `.xlsx` chosen in Refresh from Excel):

1. `POST /api/workbooks/:id/refresh` streams the Drive file (existing). The browser reads cell values and OOXML fills.
2. `POST /api/locks` `{locks:[{rowId,col}]}` for every cell that was Pink or Amber in the baseline and whose fill is now cleared. Those cells are never re-flagged.
3. `POST /api/sanity-run` `{mode:"round2", batchId, receipts:[{items:[{rowId, editedCols, clearedCols, flaggedCols, previousItemId, previousCells, unitSettled:true, ...}]}]}`. Look-up is skipped when `品牌`, `品名` and `采购商品原价` are present and verified and `品牌货号` is unedited. An edited `品牌货号` deletes that row's cache (`lookup:v2:item:...` and, when price and currency are present, `lookup:v2:pf:...:price.toFixed(2)`).
4. `POST /api/drive/upload?folder=exports&name=&batchId=&replaceId=` writes the updated workbook over the linked Drive file. A paused or unavailable look-up stays Amber.

## Free-tier guards
- Brave < 1,000/month (default guard 950), Gemini grounding < 5,000/month (4,800) and < 1,500/day (1,450). Env can lower but never raise past 999/4,999/1,499. Counters reserved atomically in D1 before each call; guard hit ⇒ look-ups pause, Amber `#FDE68A`.
- KV writes: counted per day; at 900 writes cache goes to D1 `lookup_cache`; invalidation while capped writes a D1 tombstone.
- Worker CPU: browser keeps Tesseract/image work; Functions only do fetch I/O + light JSON.

## Secrets (secure handoff only; never in code or chat)
`wrangler pages secret put <NAME> --project-name tillroll-v2` for: `GEMINI_API_KEY`, `BRAVE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (≥32 random chars), `APP_PASSCODE`.
Without keys everything runs in degraded mode (look-ups report "not configured" and flag Amber). With live keys, quota-spending endpoints refuse to run until `APP_PASSCODE` is set (public URL protection).

Google OAuth client (Web): authorised redirect URI `https://tillroll-v2.pages.dev/api/auth/google/callback` (plus any preview domain used), scope `drive.file` only.

## Deploy
```bash
cd tillroll-cloudflare
npx wrangler d1 migrations apply tillroll-v2-db --remote
npx wrangler pages project create tillroll-v2 --production-branch main   # free
npx wrangler pages deploy            # uses pages_build_output_dir = ../tillroll
```
Or connect the repo in the Cloudflare dashboard (Pages → Connect to Git): root `tillroll-cloudflare`, build command none, output `../tillroll`.

## Tests
`npm test` (Node ≥ 22, no dependencies): lookup contract, cache keys, quota guards, KV→D1 fallback, invalidation, sanity loop over every stored reading in `../tillroll/real-samples` and `../tillroll/featured`, Round 2 locks, run lifecycle, passcode gate, crypto.
