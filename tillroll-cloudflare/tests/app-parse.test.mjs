// The da34dd9 merge left tillroll/app.js unparsable as a module. node --check
// parses these files as scripts and misses that error, so this suite parses
// each tillroll/*.js file as an ES module. A second test loads the real
// index.html and executes app.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const tillroll = join(here, '../../tillroll');
const files = readdirSync(tillroll).filter(name => name.endsWith('.js')).sort().map(name => join(tillroll, name));

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

test('every tillroll/*.js file parses as an ES module', () => {
  const checker = `
    import vm from 'node:vm';
    import { readFileSync } from 'node:fs';
    const failures = [];
    for (const file of process.argv.slice(1)) {
      const src = readFileSync(file, 'utf8');
      try { new vm.SourceTextModule(src, { identifier: 'file:///' + file }); }
      catch (error) { failures.push(file + ': ' + String(error.message).split('\\n')[0]); }
    }
    if (failures.length) {
      console.error(failures.join('\\n'));
      process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', checker, ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, (result.stderr || result.stdout || 'module parse failed').replace(/\(node:\d+\).*\n/g, ''));
});

test('index.html executes app.js and binds the main handlers', async () => {
  const html = readFileSync(join(tillroll, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://tillroll.example/tillroll/index.html', pretendToBeVisual: true });
  polyfillDialog(dom.window);
  const errors = [];
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
    HTMLDialogElement: globalThis.HTMLDialogElement,
  };
  const consoleError = console.error;
  dom.window.addEventListener('error', event => errors.push(String(event.error || event.message)));
  console.error = (...args) => errors.push(args.map(arg => arg instanceof Error ? arg.stack || arg.message : String(arg)).join(' '));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.location = dom.window.location;
  globalThis.HTMLDialogElement = dom.window.HTMLDialogElement;
  try {
    await import(`../../tillroll/app.js?parse=${Date.now()}-${Math.random()}`);
    document.getElementById('history').click();
  } catch (error) {
    errors.push(error.stack || error.message);
  } finally {
    console.error = consoleError;
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    if (previous.location === undefined) delete globalThis.location;
    else globalThis.location = previous.location;
    globalThis.HTMLDialogElement = previous.HTMLDialogElement;
  }
  assert.deepEqual(errors, [], errors.join('\n'));
  const doc = dom.window.document;
  for (const id of ['history', 'excel', 'excel-china', 'csv', 'search']) {
    const el = doc.getElementById(id);
    assert.ok(el, id);
    assert.equal(typeof el.onclick === 'function' || typeof el.oninput === 'function', true, id + ' handler');
  }
  assert.equal(doc.getElementById('history-dialog').open, true);
});
