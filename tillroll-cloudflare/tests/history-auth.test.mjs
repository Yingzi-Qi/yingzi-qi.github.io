// jsdom: server history goes through the unlock dialog. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const STORAGE_KEY = 'tillroll.reading-history.v1';
const LOCAL_FILE = 'synthetic-local.jpg';
const LOCAL_NAME = 'Synthetic Local Merchant';
const SERVER_SUMMARY = 'Synthetic server event';
const SERVER_LABEL = 'Showing the reading history saved on the Tillroll server.';
const OFFLINE_LABEL = 'Showing the history kept in this browser (offline).';
const LOCKED_LABEL = 'Showing the history kept in this browser (offline, locked).';

function polyfillDialog(window) {
  const proto = window.HTMLDialogElement?.prototype;
  if (!proto) return;
  proto.showModal = function showModal() { this.setAttribute('open', ''); this.open = true; };
  proto.close = function close() {
    this.removeAttribute('open');
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function seedLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    entries: [{
      key: 'synthetic-local', filename: LOCAL_FILE, merchant: LOCAL_NAME,
      events: [{ type: 'reading', at: '2026-01-02T10:20:00.000Z', detail: '1 item line read' }],
      reading: { at: '2026-01-02T10:20:00.000Z', method: 'test', merchant: LOCAL_NAME, date: '2026-01-02', time: '10:20', lines: [] },
      lookup: null,
    }],
    events: [],
  }));
}

async function waitFor(check) {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for the unlock dialog');
}

async function boot({ host, history }) {
  const html = readFileSync(new URL('../../tillroll/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `https://${host}/tillroll/index.html`, pretendToBeVisual: true });
  polyfillDialog(dom.window);
  const calls = [];
  const fetchImpl = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/api/quota')) return json(200, { lookupsPaused: false, brave: { used: 0, limit: 1 }, pausedReasons: [], geminiGroundingDaily: { used: 0, limit: 1 }, geminiGroundingMonthly: { used: 0, limit: 1 } });
    if (path.includes('/api/auth/session')) return json(200, { drive: { connected: false, configured: false } });
    if (path.includes('/api/auth/unlock')) return json(200, {});
    if (path.includes('/api/history')) return history(calls.filter(item => item.includes('/api/history')).length);
    return json(404, { error: 'Synthetic unknown route' });
  };
  const previous = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, location: globalThis.location, fetch: globalThis.fetch, HTMLDialogElement: globalThis.HTMLDialogElement };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.location = dom.window.location;
  globalThis.fetch = fetchImpl;
  globalThis.HTMLDialogElement = dom.window.HTMLDialogElement;
  dom.window.fetch = fetchImpl;
  seedLocal();
  const stamp = `${Date.now()}-${Math.random()}`;
  await import(`../../tillroll/v2.js?history=${stamp}`);
  const { openHistory } = await import(`../../tillroll/history-dialog.js?history=${stamp}`);
  return {
    calls, openHistory,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.localStorage = previous.localStorage;
      if (previous.location === undefined) delete globalThis.location;
      else globalThis.location = previous.location;
      globalThis.fetch = previous.fetch;
      globalThis.HTMLDialogElement = previous.HTMLDialogElement;
    },
  };
}

function view() {
  const server = document.getElementById('history-server-list');
  const local = document.getElementById('history-list');
  const status = document.getElementById('history-status');
  const shown = [];
  if (server && !server.hidden) shown.push('server');
  if (local && !local.hidden) shown.push('local');
  return { server, local, status, shown, unlock: document.getElementById('v2-unlock-dialog') };
}

const serverEntries = () => json(200, { entries: [{ kind: 'reading', summary: SERVER_SUMMARY, created_at: '2026-01-02T10:20:00.000Z', batch_id: 'syn-batch' }] });

test('server history uses the unlock dialog and renders exactly one result', async (t) => {
  await t.test('200 shows the server list', async () => {
    const page = await boot({ host: 'tillroll.example', history: () => serverEntries() });
    try {
      await page.openHistory();
      const ui = view();
      assert.deepEqual(ui.shown, ['server']);
      assert.equal(ui.status.textContent, SERVER_LABEL);
      assert.match(ui.server.textContent, new RegExp(SERVER_SUMMARY));
      assert.equal(ui.local.hidden, true);
      assert.equal(page.calls.filter(url => url.includes('/api/history')).length, 1);
    } finally { page.restore(); }
  });

  await t.test('401 locked then unlock retries once and shows the server list', async () => {
    const page = await boot({
      host: 'tillroll.example',
      history: n => n === 1 ? json(401, { code: 'locked' }) : serverEntries(),
    });
    try {
      const pending = page.openHistory();
      await waitFor(() => view().unlock.open);
      const form = document.getElementById('v2-unlock-form');
      form.querySelector('[name=passcode]').value = 'synthetic-pass';
      form.onsubmit({ preventDefault() {} });
      await pending;
      const ui = view();
      assert.deepEqual(ui.shown, ['server']);
      assert.equal(ui.status.textContent, SERVER_LABEL);
      assert.match(ui.server.textContent, new RegExp(SERVER_SUMMARY));
      assert.equal(ui.unlock.open, false);
      assert.equal(page.calls.filter(url => url.includes('/api/history')).length, 2);
      assert.equal(page.calls.filter(url => url.includes('/api/auth/unlock')).length, 1);
    } finally { page.restore(); }
  });

  await t.test('401 dismissed shows the local list labelled offline and locked', async () => {
    const page = await boot({ host: 'tillroll.example', history: () => json(401, { code: 'locked' }) });
    try {
      const pending = page.openHistory();
      await waitFor(() => view().unlock.open);
      view().unlock.close();
      await pending;
      const ui = view();
      assert.deepEqual(ui.shown, ['local']);
      assert.equal(ui.status.textContent, LOCKED_LABEL);
      assert.match(ui.local.textContent, new RegExp(LOCAL_FILE));
      assert.equal(ui.server.hidden, true);
      assert.equal(ui.unlock.open, false);
      assert.equal(page.calls.filter(url => url.includes('/api/history')).length, 1);
    } finally { page.restore(); }
  });

  await t.test('5xx falls back to the local list labelled offline', async () => {
    const page = await boot({ host: 'tillroll.example', history: () => json(503, { error: 'Synthetic unavailable' }) });
    try {
      await page.openHistory();
      const ui = view();
      assert.deepEqual(ui.shown, ['local']);
      assert.equal(ui.status.textContent, OFFLINE_LABEL);
      assert.match(ui.local.textContent, new RegExp(LOCAL_NAME));
      assert.equal(ui.server.hidden, true);
      assert.equal(ui.unlock.open, false);
    } finally { page.restore(); }
  });

  await t.test('a network error falls back to the local list labelled offline', async () => {
    const page = await boot({ host: 'tillroll.example', history: () => { throw new TypeError('Synthetic network down'); } });
    try {
      await page.openHistory();
      const ui = view();
      assert.deepEqual(ui.shown, ['local']);
      assert.equal(ui.status.textContent, OFFLINE_LABEL);
      assert.equal(ui.server.hidden, true);
      assert.equal(ui.unlock.open, false);
    } finally { page.restore(); }
  });

  await t.test('another 4xx shows an error and not the local list', async () => {
    const page = await boot({ host: 'tillroll.example', history: () => json(403, { error: 'Synthetic forbidden' }) });
    try {
      await page.openHistory();
      const ui = view();
      assert.deepEqual(ui.shown, []);
      assert.equal(ui.status.textContent, 'Synthetic forbidden');
      assert.equal(ui.local.hidden, true);
      assert.equal(ui.server.hidden, true);
      assert.equal(ui.unlock.open, false);
      assert.doesNotMatch(ui.status.textContent, /offline/);
    } finally { page.restore(); }
  });

  await t.test('the GitHub Pages mirror shows the local list and does not call history', async () => {
    const page = await boot({ host: 'yingzi-qi.github.io', history: () => { throw new Error('history must not be called'); } });
    try {
      assert.equal(typeof window.tillrollV2Hooks?.serverHistory, 'undefined');
      await page.openHistory();
      const ui = view();
      assert.deepEqual(ui.shown, ['local']);
      assert.equal(ui.status.textContent, OFFLINE_LABEL);
      assert.match(ui.local.textContent, new RegExp(LOCAL_FILE));
      assert.equal(page.calls.some(url => url.includes('/api/history')), false);
    } finally { page.restore(); }
  });
});
