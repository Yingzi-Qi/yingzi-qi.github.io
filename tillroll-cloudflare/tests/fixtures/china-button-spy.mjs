// Run with: node --experimental-test-module-mocks fixtures/china-button-spy.mjs
// Synthetic only. Mocks tillroll/v2-excel.js and proves the '中文 Excel' exporter
// (exportChinaExcel, bound to #excel-china in app.js) calls the v2 writer.
import { mock } from 'node:test';
const calls = [];
const v2Url = new URL('../../../tillroll/v2-excel.js', import.meta.url).href;
mock.module(v2Url, { namedExports: {
  buildV2XlsxBlob: async input => { calls.push(input); return new Blob(['v2-spy'], { type: 'application/octet-stream' }); },
  readV2Workbook: async () => ({ kind: 'legacy' }),
} });
globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } };
URL.createObjectURL = () => 'blob:spy'; URL.revokeObjectURL = () => {};
const { exportChinaExcel } = await import('../../../tillroll/exports.js');
const receipts = [{ id: 1, state: 'done', filename: 'synthetic.jpg', review: { flags: [], photo: [] },
  data: { merchant: 'Example Goods Ltd', date: '2026-01-02', time: '10:20', orderNumber: 'SYN-ORDER-A', currency: 'GBP',
    payment: 'VISA ****1234', card: '4111111111111111', items: [{ brand: 'Acme', item: 'Test Widget', itemId: 'TW-ABC', qty: 1, unitPrice: 20, amount: 20 }] } }];
const blob = await exportChinaExcel(receipts);
const text = await blob.text();
const passed = calls[0];
console.log(JSON.stringify({ calls: calls.length, returned: text,
  payment: passed?.[0]?.data?.payment, card: passed?.[0]?.data?.card }));
