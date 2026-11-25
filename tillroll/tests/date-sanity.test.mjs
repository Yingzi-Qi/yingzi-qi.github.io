import test from 'node:test';
import assert from 'node:assert/strict';
import {batchDateFlags} from '../date-sanity.js';

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

test('batch dates: two receipts do not run the month test', () => {
  const flags = batchDateFlags([
    {id: 'one', date: '2026-11-20'},
    {id: 'two', date: '2026-12-01'},
  ], {uploadTime: '2026-12-15T12:00:00Z'});
  assert.deepEqual(flags, []);
});

test('batch dates: a cleared purchaseTime lock is not flagged again', () => {
  const flags = batchDateFlags([
    ...nov,
    {id: 'swap', date: '2026-04-11', humanVerifiedUnflagged: ['purchaseTime']},
  ], {uploadTime: '2026-11-25T12:00:00Z'});
  assert.equal(flags.some(entry => entry.id === 'swap'), false);
});
