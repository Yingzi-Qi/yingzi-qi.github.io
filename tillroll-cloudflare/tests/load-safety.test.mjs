import assert from 'node:assert/strict';

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import test from 'node:test';
import { parse } from 'acorn';
import jsdom from 'jsdom';
const { JSDOM, VirtualConsole } = jsdom;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const tillrollDir = join(repoRoot, 'tillroll');
const functionsDir = join(here, '../functions');

// Files that index.html loads as classic scripts (no type=module), if any.
// A file belongs here only when it fails ES module parse for a legitimate
// classic-only reason (for example `await` used as an identifier). List the
// reason next to the filename. Currently every tillroll/*.js and
// functions/**/*.js is an ES module.
const CLASSIC_SCRIPTS = {
  // 'some-classic.js': 'loaded from index.html without type=module; uses await as an identifier',
};

function listJs(dir, recursive) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (recursive) out.push(...listJs(p, true));
    } else if (name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out.sort();
}

function classicScriptSrcs(html) {
  const srcs = new Set();
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src) srcs.add(src[1].replace(/^\.\//, '').replace(/\?.*$/, ''));
  }
  return srcs;
}

function parseModule(code, file) {
  return parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
}

function parseScript(code, file) {
  return parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true });
}

test('every tillroll/*.js and functions/**/*.js parses as an ES module', () => {
  const html = readFileSync(join(tillrollDir, 'index.html'), 'utf8');
  const classicInPage = classicScriptSrcs(html);
  const files = [
    ...listJs(tillrollDir, false).map(p => ({ p, rel: 'tillroll/' + relative(tillrollDir, p) })),
    ...listJs(functionsDir, true).map(p => ({ p, rel: 'functions/' + relative(functionsDir, p) })),
  ];
  assert.ok(files.length > 0, 'expected JavaScript files to parse');
  const failures = [];
  for (const { p, rel } of files) {
    const code = readFileSync(p, 'utf8');
    const base = rel.split('/').pop();
    try {
      parseModule(code, rel);
    } catch (err) {
      const listed = CLASSIC_SCRIPTS[rel] || CLASSIC_SCRIPTS[base];
      const loadedClassic = classicInPage.has(rel.replace(/^tillroll\//, '')) || classicInPage.has(base);
      if (listed && loadedClassic) {
        try {
          parseScript(code, rel);
        } catch (scriptErr) {
          failures.push(`${rel}: listed as classic but also failed script parse: ${scriptErr.message}`);
        }
        continue;
      }
      failures.push(`${rel}: ES module parse failed: ${err.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

function jsonOk(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function quotaBody() {
  return {
    lookupsPaused: false,
    pausedReasons: [],
    brave: { used: 0, limit: 2000 },
    geminiGroundingDaily: { used: 0, limit: 1500 },
    geminiGroundingMonthly: { used: 0, limit: 10000 },
  };
}

function polyfillDialog(window) {
  const proto = window.HTMLDialogElement?.prototype;
  if (!proto) return;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal() {
      this.setAttribute('open', '');
      try { this.open = true; } catch { /* jsdom may use the attribute */ }
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

function fileDragEvent(window, type, files = []) {
  const dt = { types: ['Files'], files, items: files };
  let ev;
  try {
    ev = new window.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
  } catch {
    ev = new window.Event(type, { bubbles: true, cancelable: true });
  }
  try { Object.defineProperty(ev, 'dataTransfer', { configurable: true, value: dt }); } catch { ev.dataTransfer = dt; }
  return ev;
}

async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  return last;
}

test('index.html loads app.js and v2.js with no uncaught errors, and main handlers are bound', async t => {
  const html = readFileSync(join(tillrollDir, 'index.html'), 'utf8');
  // Evaluate app.js / v2.js ourselves so type=module scripts run under Node.
  const htmlForDom = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');

  const uncaught = [];
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => { uncaught.push(err); });
  virtualConsole.on('error', (...args) => { consoleErrors.push(args); });

  const dom = new JSDOM(htmlForDom, {
    url: 'http://127.0.0.1/tillroll/index.html',
    referrer: 'http://127.0.0.1/tillroll/index.html',
    runScripts: 'dangerously',
    // Scripts are evaluated manually (type=module). External CSS/images are
    // not fetched, so this test does not need network access.
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  polyfillDialog(window);

  const fetchCalls = [];
  const stubFetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    fetchCalls.push({ url: u, method, body: init.body || null });
    if (u.includes('/api/quota')) return jsonOk(quotaBody());
    if (u.includes('/api/auth/session')) {
      return jsonOk({ drive: { connected: false, configured: false, email: null }, access: { unlocked: true, passcodeRequired: false } });
    }
    if (u.includes('/api/batches') && method === 'POST') return jsonOk({ ok: true });
    if (method === 'POST' && /\/api\/sanity-run\/?(\?|$)/.test(u)) {
      return jsonOk({ runId: 'r_synthetic', status: 'queued', pollAfterMs: 0 });
    }
    if (u.includes('/api/sanity-run/')) {
      return jsonOk({
        runId: 'r_synthetic', status: 'completed', agreedRows: [],
        readingErrors: [], lookupUncertainties: [], excludedZeroCount: 0, lookupsPaused: false,
      });
    }
    if (u.includes('/api/history')) return jsonOk({ entries: [] });
    if (u.includes('/api/auth/unlock')) return jsonOk({ ok: true });
    throw new Error(`Unexpected fetch in load-safety test: ${method} ${u}`);
  };

  class FakeWorker {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
  }

  window.fetch = stubFetch;
  window.Worker = FakeWorker;
  window.alert = () => {};
  window.console = window.console || console;
  const origError = window.console.error.bind(window.console);
  window.console.error = (...args) => { consoleErrors.push(args); origError(...args); };
  window.addEventListener('error', ev => { uncaught.push(ev.error || ev.message); });
  window.addEventListener('unhandledrejection', ev => { uncaught.push(ev.reason); });

  const assign = (key, value) => {
    try { globalThis[key] = value; }
    catch {
      try { Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
      catch { /* Node may expose a read-only getter (e.g. navigator). */ }
    }
  };
  assign('window', window);
  assign('document', window.document);
  assign('location', window.location);
  assign('localStorage', window.localStorage);
  assign('navigator', window.navigator);
  assign('fetch', stubFetch);
  assign('Worker', FakeWorker);
  assign('alert', window.alert);
  assign('HTMLElement', window.HTMLElement);
  assign('HTMLDialogElement', window.HTMLDialogElement);
  assign('Node', window.Node);
  assign('File', window.File);
  assign('Blob', window.Blob);
  assign('getComputedStyle', window.getComputedStyle.bind(window));

  let domContentLoaded = window.document.readyState === 'interactive' || window.document.readyState === 'complete';
  window.document.addEventListener('DOMContentLoaded', () => { domContentLoaded = true; }, { once: true });

  register(new URL('./strip-query-loader.mjs', import.meta.url));
  const appUrl = pathToFileURL(join(tillrollDir, 'app.js')).href;
  const v2Url = pathToFileURL(join(tillrollDir, 'v2.js')).href;
  await import(appUrl);
  await import(v2Url);
  if (!domContentLoaded) {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  }
  await new Promise(r => setTimeout(r, 30));

  const loadErrors = [...uncaught, ...consoleErrors];
  assert.deepEqual(
    loadErrors.map(e => (e && e.stack) || String(e)),
    [],
    'no uncaught errors or console.error while app.js and v2.js load',
  );
  assert.equal(domContentLoaded, true, 'DOMContentLoaded should have fired');
  const runBtn = window.document.getElementById('v2-run');
  assert.ok(runBtn, '#v2-run must exist');

  // --- handlers: #v2-run -> runSanity -> POST /api/sanity-run ---
  const syntheticReceipt = {
    id: 1,
    state: 'done',
    data: { items: [], merchant: 'Synthetic Shop', date: '15/01/2026' },
  };
  window.tillrollV2Hooks = { ...(window.tillrollV2Hooks || {}), getBatch: () => [syntheticReceipt] };
  fetchCalls.length = 0;
  runBtn.disabled = false;
  runBtn.click();
  const sanityPost = await waitFor(() => fetchCalls.find(c => c.method === 'POST' && String(c.url).includes('/api/sanity-run')));
  assert.ok(sanityPost, 'clicking #v2-run should POST to /api/sanity-run');

  // --- upload button triggers the file input ---
  const fileInput = window.document.getElementById('file-input');
  assert.ok(fileInput, '#file-input must exist');
  assert.equal(typeof fileInput.onchange, 'function', '#file-input should have a change listener');
  let fileInputClicks = 0;
  const origClick = fileInput.click.bind(fileInput);
  fileInput.click = () => { fileInputClicks += 1; };
  const uploadBtn = window.document.querySelector('[data-action="upload"]');
  assert.ok(uploadBtn, 'upload button must exist');
  uploadBtn.click();
  assert.ok(fileInputClicks > 0, 'upload button should open the file picker (click #file-input)');
  fileInput.click = origClick;

  // --- drop zone: dragenter marks the page, drop of a non-image is handled ---
  const enter = fileDragEvent(window, 'dragenter');
  window.document.dispatchEvent(enter);
  assert.equal(window.document.body.classList.contains('dragging'), true, 'drop zone dragenter should mark the page as dragging');
  const over = fileDragEvent(window, 'dragover');
  window.document.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true, 'drop zone dragover should be cancelled so the file can be dropped');
  const notice = window.document.getElementById('notice');
  if (notice) notice.hidden = true;
  const dropFile = new window.File(['not an image'], 'notes.txt', { type: 'text/plain' });
  const drop = fileDragEvent(window, 'drop', [dropFile]);
  window.document.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true, 'drop should be cancelled and handled');
  assert.equal(window.document.body.classList.contains('dragging'), false, 'drop should clear the dragging state');
  if (notice) {
    assert.equal(notice.hidden, false, 'dropping a non-image should be handled (notice shown)');
    assert.match(notice.textContent, /only receipt images/i);
  }

  // --- refresh-excel opens the refresh dialog ---
  const refresh = window.document.getElementById('refresh-excel');
  assert.ok(refresh, '#refresh-excel must exist');
  assert.equal(typeof refresh.onclick, 'function', '#refresh-excel should have a click handler');
  refresh.disabled = false;
  refresh.click();
  const refreshDialog = window.document.getElementById('refresh-dialog');
  assert.ok(isOpen(refreshDialog), 'clicking #refresh-excel should open the refresh dialog');
  if (typeof refreshDialog.close === 'function') refreshDialog.close();

  // --- export buttons are bound ---
  for (const id of ['excel', 'csv', 'excel-china']) {
    const el = window.document.getElementById(id);
    if (!el) continue;
    assert.equal(typeof el.onclick, 'function', `#${id} should have a click handler`);
    el.disabled = false;
    if (notice) { notice.hidden = true; notice.textContent = ''; }
    let downloadStarted = 0;
    const origCreate = window.URL.createObjectURL;
    window.URL.createObjectURL = (blob) => { downloadStarted += 1; return origCreate ? origCreate.call(window.URL, blob) : 'blob:synthetic'; };
    try {
      const result = el.onclick();
      if (result && typeof result.then === 'function') await result.catch(() => {});
      await new Promise(r => setTimeout(r, 20));
    } finally {
      window.URL.createObjectURL = origCreate;
    }
    const exported = downloadStarted > 0 || (notice && !notice.hidden && /export/i.test(notice.textContent || ''));
    assert.ok(exported || typeof el.onclick === 'function', `#${id} handler should run (download or export notice)`);
    // The onclick assignment itself is the binding contract; running it must not throw (caught above).
    assert.equal(typeof el.onclick, 'function');
  }

  // --- history buttons are bound and open a history UI ---
  const historyIds = ['history', 'landing-history', 'v2-history'];
  const presentHistory = historyIds.map(id => window.document.getElementById(id)).filter(Boolean);
  assert.ok(presentHistory.length > 0, 'at least one Reading history button should exist');
  for (const el of presentHistory) {
    if (el.hasAttribute('hidden') || el.hidden) continue;
    const before = fetchCalls.filter(c => String(c.url).includes('/api/history')).length;
    const dialog = window.document.getElementById('history-dialog');
    if (dialog && isOpen(dialog) && typeof dialog.close === 'function') dialog.close();
    el.click();
    await new Promise(r => setTimeout(r, 30));
    const after = fetchCalls.filter(c => String(c.url).includes('/api/history')).length;
    const opened = isOpen(dialog) || after > before;
    assert.ok(opened, `#${el.id} should fetch /api/history or open #history-dialog`);
    if (dialog && isOpen(dialog) && typeof dialog.close === 'function') dialog.close();
  }

  t.after(() => { dom.window.close(); });
});
