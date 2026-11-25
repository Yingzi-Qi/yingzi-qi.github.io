import test from 'node:test';
import assert from 'node:assert/strict';
import {batchDateFlags, checkBatchDateOutliers} from '../date-sanity.js';
import {makeOcr} from './ocr-fixture.mjs';
import {extractLocal} from '../extract.js';

const nov = [
  {id: 'a', date: '2026-11-02'},
  {id: 'b', date: '2026-11-03'},
  {id: 'c', date: '2026-11-04'},
];

test('batch dates: a swapped month explains the DD/MM alternative', () => {
  const flags = batchDateFlags([...nov, {id: 'swap', date: '2026-04-11'}], {uploadTime: '2026-11-25T12:00:00Z'});
  const flag = flags.find(entry => entry.id === 'swap');
  assert.equal(flag.field, 'purchaseTime');
  assert.match(flag.message, /possible DD\/MM swap; would be 2026-11-04/);
  assert.equal(flags.some(entry => entry.id === 'a'), false);
});

test('batch dates: a date after upload is future', () => {
  const flags = batchDateFlags([...nov, {id: 'later', date: '2026-11-28'}], {uploadTime: '2026-11-20T12:00:00Z'});
  const flag = flags.find(entry => entry.id === 'later');
  assert.match(flag.message, /future date/);
  assert.equal(flag.reasons.includes('date long ago'), false);
});

test('batch dates: a 2019 date is long ago', () => {
  const flags = batchDateFlags([...nov, {id: 'old', date: '2019-11-02'}], {uploadTime: '2026-11-25T12:00:00Z'});
  const flag = flags.find(entry => entry.id === 'old');
  assert.match(flag.message, /date long ago/);
  assert.match(flag.message, /far from the rest of the batch/);
});

test('batch dates: another month inside the window is not a reading error', () => {
  const flags = batchDateFlags([...nov, {id: 'dec', date: '2026-12-01'}], {uploadTime: '2026-12-15T12:00:00Z'});
  assert.deepEqual(flags, []);
});

test('batch dates: two receipts do not run the month test', () => {
  const flags = batchDateFlags([
    {id: 'one', date: '2026-11-20'},
    {id: 'two', date: '2026-12-01'},
  ], {uploadTime: '2026-12-15T12:00:00Z'});
  assert.deepEqual(flags, []);
});

test('checkBatchDateOutliers: swap, future date, and a cleared lock', () => {
  const flags = checkBatchDateOutliers([
    {rowId: 'a', date: '2026-11-02'},
    {rowId: 'b', date: '2026-11-03'},
    {rowId: 'c', date: '2026-11-04'},
    {rowId: 'swap', date: '2026-04-11'},
    {rowId: 'later', date: '2026-11-28'},
    {rowId: 'locked', date: '2019-01-01', human_verified_unflagged: ['采购时间']},
  ], {now: '2026-11-20T12:00:00Z'});
  const swap = flags.find(entry => entry.rowId === 'swap');
  const later = flags.find(entry => entry.rowId === 'later');
  assert.equal(swap.field, '采购时间');
  assert.equal(swap.flag, '#FECDD3');
  assert.match(swap.reason, /possible DD\/MM swap; would be 2026-11-04/);
  assert.match(later.reason, /future date/);
  assert.equal(later.flag, '#FECDD3');
  assert.equal(flags.some(entry => entry.rowId === 'locked'), false);
});

test('UK dates: ambiguous day-month is read, then a month outlier is still flagged', () => {
  const slip = date => extractLocal(makeOcr(['HARRODS', date + ' 14:03', 'Scarf 10.00', 'TOTAL 10.00'])).date;
  assert.equal(slip('04/11/26'), '2026-11-04');
  assert.equal(slip('25/11/26'), '2026-11-25');
  assert.equal(extractLocal(makeOcr(['Corner Shop', '04/11/26 14:03', 'Soap 4.00', 'TOTAL 4.00'])).date, null);
  const units = [
    {rowId: 'a', date: slip('02/11/26')},
    {rowId: 'b', date: slip('03/11/26')},
    {rowId: 'c', date: slip('05/11/26')},
    {rowId: 'swap', date: slip('11/04/26')},
  ];
  assert.equal(units[3].date, '2026-04-11');
  const flag = checkBatchDateOutliers(units, {now: '2026-11-25T12:00:00Z'}).find(entry => entry.rowId === 'swap');
  assert.match(flag.reason, /possible DD\/MM swap; would be 2026-11-04/);
});

test('batch dates: a cleared purchaseTime lock is not flagged again', () => {
  const flags = batchDateFlags([
    ...nov,
    {id: 'swap', date: '2026-04-11', humanVerifiedUnflagged: ['purchaseTime']},
  ], {uploadTime: '2026-11-25T12:00:00Z'});
  assert.equal(flags.some(entry => entry.id === 'swap'), false);
});
