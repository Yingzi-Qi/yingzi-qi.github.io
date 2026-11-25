import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
register(new URL('./strip-query-loader.mjs', import.meta.url));

describe('page load', () => {
  it('loads index.html and app.js without uncaught errors or console.error', async () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: 'https://tillroll.test/tillroll/index.html',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    const install = (name, value) => {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    install('window', window);
    install('document', window.document);
    install('location', window.location);
    install('localStorage', window.localStorage);
    install('HTMLElement', window.HTMLElement);
    install('getComputedStyle', window.getComputedStyle.bind(window));

    const consoleErrors = [];
    const uncaught = [];
    const originalError = console.error;
    console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
    const onException = error => { uncaught.push(error); };
    const onRejection = reason => { uncaught.push(reason); };
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    try {
      await import(pathToFileURL(join(root, 'app.js')).href);
    } finally {
      console.error = originalError;
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(consoleErrors, [], `console.error during load:\n${consoleErrors.join('\n')}`);
    assert.deepEqual(uncaught.map(String), [], `uncaught during load:\n${uncaught.map(String).join('\n')}`);
    assert.equal(document.querySelector('h1').textContent, 'Receipts');
    assert.ok(document.querySelector('#settings'));
    assert.ok(document.querySelector('#lookup-base'));
    assert.ok(document.querySelector('#history-dialog'));
    assert.equal(document.querySelector('#v2-history-dialog'), null);
    assert.equal(document.querySelector('#v2-history'), null);
    assert.equal(document.querySelector('#landing-history'), null);
  });

  it('index.html has no duplicate element ids and loads app.js plus v2.js', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    assert.deepEqual(duplicates, []);
    assert.match(html, /<script type="module" src="\.\/app\.js[^"]*"><\/script><script type="module" src="\.\/v2\.js[^"]*"><\/script>/);
    assert.match(html, /id="v2-workbooks-dialog"/);
    assert.match(html, /id="history-dialog"/);
    assert.match(html, /id="history-server-list"/);
    assert.match(html, /id="history-list"/);
    assert.match(html, /id="v2-unlock-dialog"/);
    assert.match(html, /id="lookup-locked-dialog"/);
    assert.doesNotMatch(html, /id="v2-history-dialog"|id="v2-history"|id="landing-history"/);
    assert.match(html, /id="v2-select-bar"/);
    assert.match(html, /id="v2-check-all"/);
  });
});
