import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openReadingHistory } from '../../tillroll/v2.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tillrollDir = join(root, 'tillroll');
const indexHtml = readFileSync(join(tillrollDir, 'index.html'), 'utf8');

function sha256(buf) {
  return execFileSync('sha256sum', { input: buf, encoding: 'utf8' }).split(/\s+/)[0];
}

test('reading-policy.html and receipt-policy.js are byte-identical to fdf6475', () => {
  const repo = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  for (const rel of ['tillroll/reading-policy.html', 'tillroll/receipt-policy.js']) {
    const work = readFileSync(join(repo, rel));
    const expected = execFileSync('git', ['-C', repo, 'show', `fdf6475:${rel}`]);
    assert.equal(work.compare(expected), 0, `${rel} must be byte-identical to fdf6475`);
    assert.equal(sha256(work), sha256(expected));
  }
});

test('one visible Reading history action; the v2-nav duplicate is hidden; 中文 Excel and policy link stay', () => {
  const actions = indexHtml.match(/<div class="actions">([\s\S]*?)<\/div><\/div>\s*<div id="summary"/);
  assert.ok(actions, 'workspace actions row missing');
  const row = actions[1];
  assert.match(row, /id="history"/);
  assert.equal(/id="history"[^>]*\bhidden\b/.test(row), false, 'workspace Reading history must be visible');
  assert.match(indexHtml, /id="landing-history"/);
  assert.equal(/id="landing-history"[^>]*\bhidden\b/.test(indexHtml), false, 'landing Reading history must be visible');
  const nav = indexHtml.match(/<button id="v2-history"[^>]*>/);
  assert.ok(nav, '#v2-history should remain in the DOM for the same action');
  assert.match(nav[0], /\bhidden\b/, 'v2-nav Reading History is hidden so it is not a second visible button');
  assert.match(row, /id="excel-china"/);
  assert.match(indexHtml, /href="\.\/reading-policy\.html"/);
  assert.match(indexHtml, /id="v2-history-dialog"/);
  assert.match(indexHtml, /id="history-dialog"/);
});

function mockDialog() {
  return {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function installDom() {
  const v2 = mockDialog();
  const local = mockDialog();
  const list = { innerHTML: '' };
  const nodes = {
    'v2-history-dialog': v2,
    'history-dialog': local,
    'v2-history-list': list,
  };
  const prev = globalThis.document;
  globalThis.document = { getElementById: id => nodes[id] || null };
  return { v2, local, list, restore() { globalThis.document = prev; } };
}

function jsonResponse(ok, body, status = ok ? 200 : 503) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test('openReadingHistory: API OK shows only the v2 screen and does not open the local dialog', async () => {
  const { v2, local, list, restore } = installDom();
  let localOpened = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async (url) => {
        assert.match(String(url), /\/api\/history/);
        return jsonResponse(true, {
          entries: [{ kind: 'sanity-run', summary: 'synthetic batch', created_at: '2026-11-25T19:00:00.000Z', batch_id: 'b_test' }],
        });
      },
      openLocal: () => { localOpened += 1; local.showModal(); },
    });
    assert.equal(source, 'v2');
    assert.equal(v2.open, true, 'v2 history dialog should be open');
    assert.equal(local.open, false, 'local history dialog must stay closed');
    assert.equal(localOpened, 0, 'fallback must not be called when the API succeeds');
    assert.match(list.innerHTML, /synthetic batch/);
    assert.match(list.innerHTML, /sanity-run/);
  } finally { restore(); }
});

test('openReadingHistory: mocked API failure shows the local reading-history.js fallback and not the v2 screen', async () => {
  const { v2, local, restore } = installDom();
  let localOpened = 0;
  try {
    v2.showModal(); // if a previous attempt left it open, fallback must close it
    const source = await openReadingHistory({
      fetchImpl: async () => jsonResponse(false, { error: 'D1 is not bound.' }, 503),
      openLocal: () => { localOpened += 1; local.showModal(); },
    });
    assert.equal(source, 'local');
    assert.equal(localOpened, 1);
    assert.equal(local.open, true, 'local fallback dialog should be shown');
    assert.equal(v2.open, false, 'v2 history dialog must be closed on fallback');
  } finally { restore(); }
});

test('openReadingHistory: unreachable API (network throw) uses the local fallback', async () => {
  const { v2, local, restore } = installDom();
  try {
    const source = await openReadingHistory({
      fetchImpl: async () => { throw new Error('Failed to fetch'); },
      openLocal: () => local.showModal(),
    });
    assert.equal(source, 'local');
    assert.equal(local.open, true);
    assert.equal(v2.open, false);
  } finally { restore(); }
});

test('openReadingHistory: 401 / locked opens the unlock dialog and does not show the local fallback', async () => {
  const { v2, local, restore } = installDom();
  let localOpened = 0;
  let unlockOpened = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async () => jsonResponse(false, { error: 'Unlock Tillroll first.', code: 'locked' }, 401),
      openLocal: () => { localOpened += 1; local.showModal(); },
      unlockImpl: async () => { unlockOpened += 1; return false; },
    });
    assert.equal(source, 'cancelled');
    assert.equal(unlockOpened, 1, 'existing passcode/unlock dialog must be opened');
    assert.equal(localOpened, 0, 'fallback must not be shown when unlock is cancelled');
    assert.equal(local.open, false);
    assert.equal(v2.open, false, 'v2 history dialog must stay closed if unlock is cancelled');
  } finally { restore(); }
});

test('openReadingHistory: 401 then unlock success retries and shows only the v2 dialog', async () => {
  const { v2, local, list, restore } = installDom();
  let localOpened = 0;
  let unlockOpened = 0;
  let historyCalls = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async (url) => {
        assert.match(String(url), /\/api\/history/);
        historyCalls += 1;
        if (historyCalls === 1) return jsonResponse(false, { error: 'Unlock Tillroll first.', code: 'locked' }, 401);
        return jsonResponse(true, {
          entries: [{ kind: 'sanity-run', summary: 'after unlock', created_at: '2026-11-25T19:00:00.000Z', batch_id: 'b_retry' }],
        });
      },
      openLocal: () => { localOpened += 1; local.showModal(); },
      unlockImpl: async () => { unlockOpened += 1; return true; },
    });
    assert.equal(source, 'v2');
    assert.equal(unlockOpened, 1);
    assert.equal(historyCalls, 2, 'history fetch must be retried after a successful unlock');
    assert.equal(v2.open, true, 'v2 history dialog should be open after unlock');
    assert.equal(local.open, false);
    assert.equal(localOpened, 0);
    assert.match(list.innerHTML, /after unlock/);
  } finally { restore(); }
});
