// jsdom: exactly one Reading History list is shown in each of the three modes.
// Synthetic data only. Isolated from other test files' document stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const STORAGE_KEY = 'tillroll.reading-history.v1';
const LOCAL_NAME = 'Synthetic Local Merchant';
const LOCAL_FILE = 'synthetic-local.jpg';
const SERVER_SUMMARY = 'Synthetic server event';

function polyfillDialog(window) {
  const proto = window.HTMLDialogElement?.prototype;
  if (!proto || typeof proto.showModal === 'function') return;
  proto.showModal = function showModal() {
    this.setAttribute('open', '');
    this.open = true;
  };
  proto.close = function close() {
    this.removeAttribute('open');
    this.open = false;
  };
}

async function loadDialog() {
  const html = readFileSync(new URL('../../tillroll/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://tillroll.example/tillroll/' });
  polyfillDialog(dom.window);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLDialogElement = dom.window.HTMLDialogElement;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    entries: [{
      key: 'synthetic-local',
      filename: LOCAL_FILE,
      merchant: LOCAL_NAME,
      events: [{ type: 'reading', at: '2026-01-02T10:20:00.000Z', detail: '1 item line read' }],
      reading: { at: '2026-01-02T10:20:00.000Z', method: 'test', merchant: LOCAL_NAME, date: '2026-01-02', time: '10:20', lines: [] },
      lookup: null,
    }],
    events: [],
  }));
  // Cache-bust the module so each case gets a fresh historyMode.
  const { openHistory } = await import(`../../tillroll/history-dialog.js?case=${Date.now()}-${Math.random()}`);
  return { dom, openHistory };
}

function lists() {
  const server = document.getElementById('history-server-list');
  const local = document.getElementById('history-list');
  assert.ok(server && local, 'both list containers exist in the one dialog');
  const shown = [];
  if (!server.hidden) shown.push('server');
  if (!local.hidden) shown.push('local');
  return { server, local, shown, clear: document.getElementById('history-clear'), status: document.getElementById('history-status') };
}

function assertOneList(expected, { server, local, shown, clear }) {
  assert.deepEqual(shown, [expected], `exactly one list must render, expected ${expected}`);
  if (expected === 'server') {
    assert.equal(server.hidden, false);
    assert.equal(local.hidden, true);
    assert.equal(clear.hidden, true);
    assert.match(server.textContent, new RegExp(SERVER_SUMMARY));
    assert.doesNotMatch(server.textContent, new RegExp(LOCAL_FILE));
  } else {
    assert.equal(local.hidden, false);
    assert.equal(server.hidden, true);
    assert.equal(clear.hidden, false);
    assert.match(local.textContent, new RegExp(LOCAL_FILE));
    assert.match(local.textContent, new RegExp(LOCAL_NAME));
    assert.doesNotMatch(local.textContent, new RegExp(SERVER_SUMMARY));
  }
}

test('exactly one history list renders when signed in, signed out, or the API fails', async (t) => {
  await t.test('signed in: server list only', async () => {
    const { openHistory } = await loadDialog();
    window.tillrollV2Hooks = {
      serverHistory: async () => ({ ok: true, entries: [{ kind: 'reading', summary: SERVER_SUMMARY, created_at: '2026-01-02T10:20:00.000Z', batch_id: 'syn-batch' }] }),
    };
    await openHistory();
    assertOneList('server', lists());
  });

  await t.test('signed out: localStorage list only', async () => {
    const { openHistory } = await loadDialog();
    window.tillrollV2Hooks = {}; // v2-static / no serverHistory hook
    await openHistory();
    assertOneList('local', lists());
  });

  await t.test('API failure: localStorage fallback only', async () => {
    const { openHistory } = await loadDialog();
    window.tillrollV2Hooks = { serverHistory: async () => ({ ok: false, status: 500 }) };
    await openHistory();
    assertOneList('local', lists());

    // A thrown hook is also a fallback, not a second list.
    const again = await loadDialog();
    again.dom.window.tillrollV2Hooks = { serverHistory: async () => { throw new Error('network'); } };
    // loadDialog set global window; re-bind hooks on the new window
    window.tillrollV2Hooks = again.dom.window.tillrollV2Hooks;
    await again.openHistory();
    assertOneList('local', lists());
  });
});
