import {makeOcr} from '../ocr-fixture.mjs';

const cleanChanelOcr = makeOcr([
  'CHANEL',
  '15/11/2026 10:04',
  'Receipt # SYN-CH-0001',
  'Chanel A12345 Synthetic wool coat 120.00 120.00',
  'TOTAL (1 item) 120.00',
  'VISA',
]);

export const goldenDataset = {
  asOf: '2026-11-16T12:00:00Z',
  catalogue: [{
    brand: 'Chanel',
    itemId: 'A12345',
    name: 'Synthetic wool coat',
    pricePence: 12000,
    currency: 'GBP',
    url: 'https://synthetic.example/catalogue/A12345',
  }],
  fixtures: [{
    id: 'synthetic-chanel-01',
    sha256: 'synthetic-shared-image-hash',
    ocr: cleanChanelOcr,
    expected: {
      gate: 'pass',
      receiptId: 'SYN-CH-0001',
      rows: [{
        '采购小票id': 'SYN-CH-0001',
        '采购时间': '2026-11-15 10:04:00',
        供应商: 'Chanel',
        品牌: 'Chanel',
        品名: 'Synthetic Wool Coat',
        品牌货号: 'A12345',
        采购商品原价: 120,
        采购商品金额: 120,
        采购商品方法: 'Card',
        销售金额: 105.6,
      }],
    },
  }, {
    id: 'synthetic-chanel-duplicate',
    sha256: 'synthetic-shared-image-hash',
    ocr: cleanChanelOcr,
    expected: {
      gate: 'review',
      receiptId: 'SYN-CH-0001',
      reviewReason: 'Duplicate receipt detected by image hash',
      rows: [],
    },
  }, {
    id: 'synthetic-total-review',
    ocr: makeOcr([
      'CHANEL',
      '15/11/2026 10:05',
      'Receipt # SYN-CH-0002',
      'Chanel A12345 Synthetic wool coat 120.00 120.00',
      'TOTAL (1 item) 130.00',
      'VISA',
    ]),
    expected: {
      gate: 'review',
      receiptId: 'SYN-CH-0002',
      reviewReason: 'does not reconcile',
      rows: [],
    },
  }],
};

export const goldenFixtures = goldenDataset.fixtures;

