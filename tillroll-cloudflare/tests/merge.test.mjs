// Local merge resolution tests (#4 + main fdf6475). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SYN_CARD = '4111111111111111';
const SYN_PAYMENT = 'VISA ****1234';
const CARD_DIGIT_RUNS = ['4111111111111111', '411111', '1234'];

// Deterministic, digit-free UUIDs so a random key can never contain a card digit run.
let uuidN = 0;
const letters = n => n.toString(26).replace(/[0-9]/g, d => 'qrstuvwxyz'[d]);
globalThis.crypto.randomUUID = () => `uuid-${letters(++uuidN)}`;
globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } };
URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};

const ex = await import('../../tillroll/exports.js');
const v2 = await import('../../tillroll/v2-excel.js');
const { default: JSZip } = await import('../../tillroll/export-vendor/jszip.min.js');

function receipts() {
  return [{
    id: 1, state: 'done', filename: 'synthetic-a.jpg', review: { flags: [], photo: [] },
    data: { merchant: 'Example Goods Ltd', date: '2026-01-02', time: '10:20', orderNumber: 'SYN-ORDER-A', currency: 'GBP',
      payment: SYN_PAYMENT, card: SYN_CARD, total: 50,
      items: [
        { brand: 'Acme', item: 'Test Widget', itemId: 'TW-ABC', qty: 1, unitPrice: 20, amount: 20 },
        { brand: 'Acme', item: 'Sample Gadget', itemId: 'SG-XYZ', qty: 1, unitPrice: 30, amount: 30 },
        { brand: 'Acme', item: 'Free Sample', itemId: 'FS-QQ', qty: 1, unitPrice: 0, amount: 0 },
      ] },
  }];
}
async function allParts(blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out = {};
  for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) out[name] = await zip.file(name).async('string');
  return out;
}
function assertNoCardDigits(label, text) {
  for (const run of CARD_DIGIT_RUNS) assert.ok(!text.includes(run), `${label} contains a card digit run`);
}
async function assertWorkbookClean(label, blob) {
  const parts = await allParts(blob);
  assert.ok(Object.keys(parts).length > 3, `${label} is a workbook`);
  for (const [name, text] of Object.entries(parts)) assertNoCardDigits(`${label}:${name}`, text);
  return parts;
}

test('maskCardDigits replaces every digit', () => {
  assert.equal(ex.maskCardDigits(SYN_PAYMENT), 'VISA ********');
  assert.ok(!/\d/.test(ex.maskCardDigits(SYN_CARD)));
  assert.equal(ex.maskCardDigits(null), null);
});

test('no card digits in the v2 export (Export Excel), any sheet, comment or baseline', async () => {
  const blob = await ex.buildXlsxBlob(receipts());
  const parts = await assertWorkbookClean('v2', blob);
  assert.ok(parts['xl/worksheets/sheet1.xml'].includes('Tillroll original values'));
});

test('no card digits in the delegated 中文 Excel export', async () => {
  const blob = await ex.exportChinaExcel(receipts());
  await assertWorkbookClean('china', blob);
});

test('no card digits in the v2 Round 2 writer (server rows)', async () => {
  const rows = [{ rowId: 'row-a', receiptKey: 'rk-a', lineIndex: 0,
    cells: { '采购小票id': 'SYN-ORDER-A', '采购时间': '2026-01-02 10:20:00', '供应商': 'Example Goods Ltd', '品牌': 'Acme', '品名': 'Test Widget',
      '品牌货号': 'TW-ABC', '采购商品原价': 20, '采购商品金额': 20, '采购商品方法': SYN_PAYMENT, '销售金额': 17.6 },
    flags: { '品名': v2.AMBER }, exportMeta: { comments: { '品名': 'Synthetic comment' } } }];
  await assertWorkbookClean('round2', await v2.buildV2XlsxBlob({ agreedRows: rows }));
});

test('no card digits in the legacy English paths still reachable (CSV, legacy china writer, baselines)', async () => {
  const csv = await ex.buildCsvBlob(receipts()).text();
  assertNoCardDigits('csv', csv);
  assert.ok(csv.includes('"Card"'));
  const parts = await assertWorkbookClean('legacy-china', await ex.buildChinaXlsxBlob(receipts()));
  // The hidden English detailed columns and the baseline JSON are present and masked.
  const sheet = parts['xl/worksheets/sheet1.xml'];
  assert.ok(sheet.includes('Tillroll original values') && sheet.includes('Card'));
  assert.ok(sheet.includes('****************'), 'card column is written masked');
});

test('中文 Excel produces the v2 contract: 10 visible headers, hidden K:R, Pink/Amber only, no #FFEDC0', async () => {
  const blob = await ex.exportChinaExcel(receipts());
  const parts = await allParts(blob);
  const sheet = parts['xl/worksheets/sheet1.xml'];
  const book = parts['xl/workbook.xml'];
  const headerRow = sheet.match(/<row r="1"[\s\S]*?<\/row>/)[0];
  const headers = [...headerRow.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(m => m[1]);
  assert.deepEqual(headers.slice(0, 10), v2.VISIBLE_COLUMNS);
  assert.deepEqual(headers.slice(10), v2.HIDDEN_COLUMNS);
  assert.equal(headers.length, 18);
  assert.match(sheet, /<col min="11" max="11"[^>]*hidden="1"/);
  assert.match(sheet, /<col min="18" max="18"[^>]*hidden="1"/);
  assert.doesNotMatch(sheet, /<col min="10" max="10"[^>]*hidden="1"/);
  const fills = [...parts['xl/styles.xml'].matchAll(/rgb="FF([0-9A-F]{6})"/gi)].map(m => m[1].toUpperCase());
  const fillBlock = parts['xl/styles.xml'].match(/<fills[\s\S]*?<\/fills>/)[0];
  const fillColours = [...fillBlock.matchAll(/fgColor rgb="(?:FF)?([0-9A-F]{6})"/gi)].map(m => m[1].toUpperCase());
  // 1E4946 is the header-row fill (row 1 only); every review fill is Pink or Amber.
  for (const c of fillColours) assert.ok(['FECDD3', 'FDE68A', '1E4946'].includes(c), 'only Pink/Amber review fills, saw ' + c);
  assert.ok(fillColours.includes('FECDD3') && fillColours.includes('FDE68A'));
  for (const text of Object.values(parts)) assert.ok(!/FFEDC0/i.test(text), 'no #FFEDC0 anywhere');
  assert.ok(fills.length > 0);
  assert.match(book, /name="Excluded zero items"/);
  assert.match(book, /name="Flags"/);
  // The zero-price synthetic line is Pink-flagged (Round 1 rule) and appears on Flags.
  const round = await v2.readV2Workbook(blob);
  assert.equal(round.kind, 'v2');
});

test('中文 Excel button handler is bound to exportChinaExcel, which calls the v2 writer (module spy)', () => {
  const app = readFileSync(new URL('../../tillroll/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../tillroll/index.html', import.meta.url), 'utf8');
  assert.match(app, /\$\('#excel-china'\)\.onclick=\(\)=>downloadBatch\(exportChinaExcel\);/);
  assert.match(app, /import \{[^}]*\bexportChinaExcel\b[^}]*\} from '\.\/exports\.js\?v=merge1'/);
  assert.equal((html.match(/id="excel-china"/g) || []).length, 1);
  const out = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings',
    new URL('./fixtures/china-button-spy.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.calls, 1, 'buildV2XlsxBlob called exactly once');
  assert.equal(r.returned, 'v2-spy', 'the downloaded blob is the v2 writer output');
  assert.ok(!/\d/.test(r.payment) && !/\d/.test(r.card), 'receipts reach the v2 writer already masked');
});

test('refresh routing: v2/中文 workbook -> v2 Round 2; main-era 中文 workbook -> legacy clearedFields path', async () => {
  const fileOf = (blob, name) => Object.assign(blob, { name });
  const v2book = await ex.readTillrollEdits(fileOf(await ex.buildXlsxBlob(receipts()), 'v2.xlsx'));
  assert.equal(v2book.kind, 'v2');
  // A main-era 中文 workbook (Chinese columns + hidden English detailed columns with
  // 'Tillroll line key') is NOT treated as v2, so readTillrollEdits falls through to
  // main's legacy reader (clearedFields/manualClears). That reader needs a browser
  // DOMParser, so only the routing decision is asserted under Node.
  const legacy = await v2.readV2Workbook(await ex.buildChinaXlsxBlob(receipts()));
  assert.equal(legacy.kind, 'legacy');
  const app = readFileSync(new URL('../../tillroll/app.js', import.meta.url), 'utf8');
  assert.match(app, /if\(workbook\.kind==='v2'\)\{\s*const \{applyV2Refresh\}=await import\('\.\/v2-excel\.js'\);/);
});

test('one Reading History control and dialog; server-backed with local fallback', () => {
  const html = readFileSync(new URL('../../tillroll/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../tillroll/app.js', import.meta.url), 'utf8');
  const v2js = readFileSync(new URL('../../tillroll/v2.js', import.meta.url), 'utf8');
  assert.equal((html.match(/id="history"/g) || []).length, 1);
  assert.equal((html.match(/<dialog id="history-dialog"/g) || []).length, 1);
  assert.ok(!/v2-history|landing-history/.test(html + app + v2js));
  assert.match(html, /id="history-server-list"/);
  assert.match(html, /href="\.\/reading-policy\.html"/);
  assert.match(v2js, /serverHistory,/);
  assert.match(app, /window\.tillrollV2Hooks\?\.serverHistory/);
  for (const v of ['style.css?v=merge1', 'v2.css?v=merge1', 'app.js?v=merge1', 'v2.js?v=merge1']) assert.ok(html.includes(v), v);
});
