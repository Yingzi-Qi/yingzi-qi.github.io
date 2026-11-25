// Post-sanity 中文 Excel uses the v2 workbook, not the retired slim writer.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const COLUMNS = ['采购小票id', '采购时间', '供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额', '采购商品方法', '销售金额'];
const PRICE = 100;
const SALE = Math.round((PRICE * 0.88 + Number.EPSILON) * 100) / 100;

function syntheticResult() {
  return {
    agreedRows: [{
      rowId: 'syn-row',
      receiptKey: 'syn-receipt',
      cells: {
        '采购小票id': 'SYN-A',
        '采购时间': '2026-06-15 19:05:00',
        '供应商': 'Synthetic Merchant',
        '品牌': 'Acme',
        '品名': 'Test Widget',
        '品牌货号': 'TW-ABC',
        '采购商品原价': PRICE,
        '采购商品金额': PRICE,
        '采购商品方法': 'VISA ****1234',
        '销售金额': SALE,
      },
      flags: { '品名': '#FECDD3', '品牌': '#FDE68A' },
      flagReasons: { '品名': 'Name needs checking', '品牌': 'Look-up uncertainty' },
    }],
    excludedZero: [{ receiptId: 'SYN-A', purchaseTime: '2026-06-15 19:05:00', receiptKey: 'syn-receipt', lineIndex: 1, name: 'Free Sample', qty: 1, unitPrice: 0, amount: 0, reason: 'Confirmed printed zero.' }],
    readingErrors: [],
    lookupUncertainties: [],
    excludedZeroCount: 1,
    lookupsPaused: false,
    pausedReasons: [],
  };
}

async function partsOf(blob) {
  const { default: JSZip } = await import('../../tillroll/export-vendor/jszip.min.js');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out = {};
  for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) out[name] = await zip.file(name).async('string');
  return out;
}

function assertContract(parts) {
  const sheet = parts['xl/worksheets/sheet1.xml'];
  const styles = parts['xl/styles.xml'];
  const book = parts['xl/workbook.xml'];
  assert.ok(sheet && styles && book);
  let at = 0;
  for (const header of COLUMNS) {
    const next = sheet.indexOf(header, at);
    assert.ok(next > at, header);
    at = next;
  }
  assert.equal(sheet.includes('<f>'), false);
  assert.equal(sheet.includes('<f '), false);
  assert.ok(sheet.includes(`<v>${SALE}</v>`), '销售金额 is the rounded number');
  assert.ok(sheet.includes(`<v>${PRICE}</v>`));
  assert.ok(sheet.includes('>Card<') || sheet.includes('>Card</t>'));
  assert.ok(!sheet.includes('VISA'));
  assert.ok(!sheet.includes('1234'));
  assert.ok(styles.includes('FFFECDD3') && styles.includes('FFFDE68A'));
  assert.ok(!/FFEDC0/i.test(Object.values(parts).join('\n')));
  assert.match(sheet, /<col min="11" max="11"[^>]*hidden="1"/);
  assert.match(sheet, /<col min="18" max="18"[^>]*hidden="1"/);
  assert.doesNotMatch(sheet, /<col min="10" max="10"[^>]*hidden="1"/);
  assert.match(book, /name="Excluded zero items"/);
  assert.match(book, /name="Flags"/);
  assert.match(parts['xl/worksheets/sheet2.xml'], /Free Sample/);
  assert.match(parts['xl/worksheets/sheet3.xml'], /#FECDD3/);
  assert.match(parts['xl/worksheets/sheet3.xml'], /#FDE68A/);
  for (const text of Object.values(parts)) {
    assert.ok(!text.includes('VISA ****1234'));
    assert.ok(!text.includes('1234'));
  }
}

test('post-sanity 中文 Excel is the v2 workbook', async () => {
  const v2js = readFileSync(new URL('../../tillroll/v2.js', import.meta.url), 'utf8');
  assert.match(v2js, /exportAgreed\(lastResult\)/);
  assert.equal(v2js.includes('exportAgreedChina'), false);
  const exportsSrc = readFileSync(new URL('../../tillroll/exports.js', import.meta.url), 'utf8');
  assert.match(exportsSrc, /export async function exportAgreedChina\(result\) \{[\s\S]*buildV2XlsxBlob\(input\)/);
  assert.match(exportsSrc, /LEGACY_CHINA_WRITER=false/);

  const html = readFileSync(new URL('../../tillroll/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://tillroll.example/tillroll/index.html', pretendToBeVisual: true });
  const proto = dom.window.HTMLDialogElement.prototype;
  proto.showModal = function showModal() { this.open = true; };
  proto.close = function close() { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const blobs = [];
  const fetchImpl = async (url) => {
    const path = String(url);
    if (path.includes('/api/drive/upload')) return new Response(JSON.stringify({ file: { id: 'syn-file', name: 'Tillroll receipts.xlsx' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path.includes('/api/quota')) return new Response(JSON.stringify({ lookupsPaused: false, brave: { used: 0, limit: 1 }, pausedReasons: [], geminiGroundingDaily: { used: 0, limit: 1 }, geminiGroundingMonthly: { used: 0, limit: 1 } }), { status: 200 });
    if (path.includes('/api/auth/session')) return new Response(JSON.stringify({ drive: { connected: false, configured: false } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const previous = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, location: globalThis.location, fetch: globalThis.fetch, HTMLDialogElement: globalThis.HTMLDialogElement, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.location = dom.window.location;
  globalThis.fetch = fetchImpl;
  globalThis.HTMLDialogElement = dom.window.HTMLDialogElement;
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:synthetic'; };
  URL.revokeObjectURL = () => {};
  try {
    const result = syntheticResult();
    await import(`../../tillroll/v2.js?post-sanity=${Date.now()}`);
    window.tillrollV2Hooks.showResult(result);
    document.getElementById('excel-china').click();
    for (let i = 0; i < 40 && !blobs.length; i++) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(blobs.length, 1);
    assertContract(await partsOf(blobs[0]));

    blobs.length = 0;
    const { exportAgreedChina } = await import('../../tillroll/exports.js');
    await exportAgreedChina(result);
    assert.equal(blobs.length, 1);
    assertContract(await partsOf(blobs[0]));
    const history = document.getElementById('history-local-choice');
    assert.equal(history?.textContent, 'Show history kept in this browser');
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    if (previous.location === undefined) delete globalThis.location;
    else globalThis.location = previous.location;
    globalThis.fetch = previous.fetch;
    globalThis.HTMLDialogElement = previous.HTMLDialogElement;
    URL.createObjectURL = previous.createObjectURL;
    URL.revokeObjectURL = previous.revokeObjectURL;
  }
});
