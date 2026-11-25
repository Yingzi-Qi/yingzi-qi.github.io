import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openReadingHistory } from '../../tillroll/v2.js';
import jsdom from 'jsdom';
const { JSDOM } = jsdom;


const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tillrollDir = join(root, 'tillroll');
const indexHtml = readFileSync(join(tillrollDir, 'index.html'), 'utf8');

function sha256(buf) {
  return execFileSync('sha256sum', { input: buf, encoding: 'utf8' }).split(/\s+/)[0];
}

test('reading-policy.html and receipt-policy.js are byte-identical to 344c524', () => {
  const repo = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  for (const rel of ['tillroll/reading-policy.html', 'tillroll/receipt-policy.js']) {
    const work = readFileSync(join(repo, rel));
    const expected = execFileSync('git', ['-C', repo, 'show', `344c524:${rel}`]);
    assert.equal(work.compare(expected), 0, `${rel} must be byte-identical to 344c524`);
    assert.equal(sha256(work), sha256(expected));
  }
});

test('中文 Excel, policy link, and the existing #history dialog stay in the page', () => {
  const actions = indexHtml.match(/<div class="actions">([\s\S]*?)<\/div><\/div>\s*<div id="summary"/);
  assert.ok(actions, 'workspace actions row missing');
  const row = actions[1];
  assert.match(row, /id="history"/);
  assert.match(indexHtml, /id="landing-history"/);
  assert.match(row, /id="excel-china"/);
  assert.match(indexHtml, /href="\.\/reading-policy\.html"/);
  assert.match(indexHtml, /id="history-dialog"/);
  assert.match(indexHtml, /id="history-list"/);
});

function polyfillDialog(window) {
  const proto = window.HTMLDialogElement?.prototype;
  if (!proto) return;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal() {
      this.setAttribute('open', '');
      try { this.open = true; } catch { /* attribute only */ }
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close() {
      this.removeAttribute('open');
      try { this.open = false; } catch { /* ignore */ }
    };
  }
}

function isOpen(el) {
  return Boolean(el) && (el.open === true || el.hasAttribute('open'));
}

function installPage() {
  const dom = new JSDOM(indexHtml.replace(/<script\b[\s\S]*?<\/script>/gi, ''), {
    url: 'http://127.0.0.1/tillroll/index.html',
    pretendToBeVisual: true,
  });
  polyfillDialog(dom.window);
  const prev = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  try { globalThis.window = dom.window; } catch { /* read-only */ }
  return {
    window: dom.window,
    document: dom.window.document,
    restore() {
      try { globalThis.document = prev.document; } catch { /* ignore */ }
      try { globalThis.window = prev.window; } catch { /* ignore */ }
      dom.window.close();
    },
  };
}

function jsonResponse(ok, body, status = ok ? 200 : 503) {
  return { ok, status, json: async () => body };
}

const serverEntries = [
  { kind: 'sanity-run', summary: 'synthetic batch', created_at: '2026-11-25T19:00:00.000Z', batch_id: 'b_test' },
];

test('jsdom: 200 renders server rows in #history and does not use the local fallback', async () => {
  const { document, restore } = installPage();
  let localOpened = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async (url) => {
        assert.match(String(url), /\/api\/history/);
        return jsonResponse(true, { entries: serverEntries });
      },
      openLocal: () => { localOpened += 1; },
    });
    assert.equal(source, 'v2');
    const dialog = document.getElementById('history-dialog');
    assert.ok(isOpen(dialog), '#history-dialog should be open');
    const list = document.getElementById('history-server-list') || document.getElementById('history-list');
    assert.match(list.innerHTML, /synthetic batch/);
    assert.match(list.innerHTML, /sanity-run/);
    assert.equal(localOpened, 0, 'local fallback must not run when the API succeeds');
  } finally { restore(); }
});

test('jsdom: 401 opens unlock, retries after success, and renders server rows in #history', async () => {
  const { document, restore } = installPage();
  let localOpened = 0;
  let unlockOpened = 0;
  let historyCalls = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async (url) => {
        assert.match(String(url), /\/api\/history/);
        historyCalls += 1;
        if (historyCalls === 1) return jsonResponse(false, { error: 'Unlock Tillroll first.', code: 'locked' }, 401);
        return jsonResponse(true, { entries: serverEntries });
      },
      openLocal: () => { localOpened += 1; },
      unlockImpl: async () => { unlockOpened += 1; return true; },
    });
    assert.equal(source, 'v2');
    assert.equal(unlockOpened, 1);
    assert.equal(historyCalls, 2, 'history fetch must be retried after a successful unlock');
    assert.ok(isOpen(document.getElementById('history-dialog')));
    const list = document.getElementById('history-server-list') || document.getElementById('history-list');
    assert.match(list.innerHTML, /synthetic batch/);
    assert.equal(localOpened, 0);
  } finally { restore(); }
});

test('jsdom: 401 cancelled unlock shows nothing extra (no local fallback)', async () => {
  const { document, restore } = installPage();
  let localOpened = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async () => jsonResponse(false, { error: 'Unlock Tillroll first.', code: 'locked' }, 401),
      openLocal: () => { localOpened += 1; },
      unlockImpl: async () => false,
    });
    assert.equal(source, 'cancelled');
    assert.equal(localOpened, 0);
    assert.equal(isOpen(document.getElementById('history-dialog')), false);
  } finally { restore(); }
});

test('jsdom: 5xx falls back to the localStorage/offline history in #history', async () => {
  const { document, restore } = installPage();
  let localOpened = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async () => jsonResponse(false, { error: 'D1 is not bound.' }, 503),
      openLocal: () => {
        localOpened += 1;
        document.getElementById('history-list').innerHTML = '<p class="history-empty">offline local history</p>';
        const d = document.getElementById('history-dialog');
        if (d && !d.open) d.showModal();
      },
    });
    assert.equal(source, 'local');
    assert.equal(localOpened, 1);
    assert.ok(isOpen(document.getElementById('history-dialog')));
    assert.match(document.getElementById('history-list').innerHTML, /offline local history/);
  } finally { restore(); }
});

test('jsdom: network throw falls back to the localStorage/offline history', async () => {
  const { document, restore } = installPage();
  let localOpened = 0;
  try {
    const source = await openReadingHistory({
      fetchImpl: async () => { throw new Error('Failed to fetch'); },
      openLocal: () => {
        localOpened += 1;
        const d = document.getElementById('history-dialog');
        if (d && !d.open) d.showModal();
      },
    });
    assert.equal(source, 'local');
    assert.equal(localOpened, 1);
    assert.ok(isOpen(document.getElementById('history-dialog')));
  } finally { restore(); }
});
