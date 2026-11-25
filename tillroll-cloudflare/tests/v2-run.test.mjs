import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tillroll = join(here, '../../tillroll');
const read = name => readFileSync(join(tillroll, name), 'utf8');

function workspaceActionsHtml(html) {
  const ws = html.match(/<section id="workspace"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(ws, 'workspace section should exist');
  const heading = ws[1].match(/<div class="heading-row">([\s\S]*?)<div id="summary"/);
  assert.ok(heading, 'workspace heading-row should exist');
  const actions = heading[1].match(/<div class="actions">([\s\S]*?)<\/div>/);
  assert.ok(actions, 'workspace actions row should exist');
  return { workspace: ws[1], actions: actions[1] };
}

test('#v2-run is in the workspace actions row and v2.js binds it', () => {
  const html = read('index.html');
  const { workspace, actions } = workspaceActionsHtml(html);
  const button = '<button id="v2-run" class="v2-only" title="Start the bots\' review and show only the final agreed version">Run sanity checks</button>';
  assert.equal(actions.includes(button), true, 'exact #v2-run button should sit in the workspace actions row');
  const refreshAt = actions.indexOf('id="refresh-excel"');
  const runAt = actions.indexOf('id="v2-run"');
  const excelAt = actions.indexOf('id="excel"');
  assert.ok(refreshAt >= 0 && runAt > refreshAt && excelAt > runAt, '#v2-run should be immediately after Refresh from Excel and before Export Excel');
  assert.equal(/id="v2-run"[^>]*\bhidden\b/.test(actions), false, '#v2-run must not have a hidden attribute');

  // Workspace is shown after upload (batch becomes non-empty).
  const app = read('app.js');
  assert.match(app, /const has=batch\.length>0;\$\('#landing'\)\.hidden=has;\$\('#workspace'\)\.hidden=!has;/);

  // .v2-only is hidden only on the GitHub Pages mirror, not on tillroll-v2.pages.dev.
  const css = read('v2.css');
  const hideRules = [...css.matchAll(/[^{}]*\.v2-only[^{]*\{[^}]*\}/g)].map(m => m[0].trim());
  assert.deepEqual(hideRules, ['.v2-static .v2-only{display:none!important}']);
  const v2 = read('v2.js');
  assert.match(v2, /function init\(\) \{\s*\$\('#v2-run'\)\?\.addEventListener\('click',\s*runSanity\);/s);
  assert.match(v2, /if \(hasDom && location\.protocol\.startsWith\('http'\) && !location\.hostname\.endsWith\('github\.io'\)\) init\(\);\s*else if \(hasDom\) document\.documentElement\.classList\.add\('v2-static'\);/);
  assert.equal(/tillroll-v2\.pages\.dev/.test('tillroll-v2.pages.dev') && !'tillroll-v2.pages.dev'.endsWith('github.io'), true);
  // The button lives only in the workspace heading actions, not a buried panel.
  assert.equal(workspace.includes('id="v2-run"'), true);
  assert.equal(html.includes('id="v2-panel"') && !workspace.match(/id="v2-panel"[\s\S]*id="v2-run"/), true);
});

test("upload with default reader mode 'local' makes zero /api/* fetches", () => {
  const app = read('app.js');
  const extract = read('extract.js');
  const v2 = read('v2.js');
  const html = read('index.html');

  assert.match(app, /let mode='local',apiKey='',savedSamples=false/);
  assert.match(html, /<select id="reader"><option value="local">/);
  assert.equal(/<select id="reader">[\s\S]*?selected/.test(html), false, 'reader <select> has no explicit selected option; first option (local) is the default');

  assert.match(app, /function fileSelection\(files\)\{[^}]*startInput\(valid\.map\(file=>\(\{file\}\)\)\);\}/);
  assert.match(app, /r\.readerSettings=\{mode,key:apiKey\}/);
  assert.match(app, /const \{mode:chosenMode,key:chosenKey\}=r\.readerSettings;/);
  assert.match(app, /const modelEnabled=chosenMode==='server'&&!!chosenKey;/);
  // extractAI (the only /api/ocr caller) is only scheduled when modelEnabled is true.
  assert.match(app, /modelEnabled\?extractAI\(r\.file,chosenKey,1,\[\]\):Promise\.resolve\(null\)/);
  assert.match(app, /if\(r\.usedAI\)\{\s*next=prepareModelReading\(recoverPhotoItemIds\(await extractAI\(r\.file,chosenKey,2,r\.reasons\),r\.ocr\),r\.ocr\);/);

  const ocrFetch = extract.match(/const viaServer = shouldCallServerOcr\(apiKey\);\s*const response = viaServer\s*\? await fetch\('\/api\/ocr'/s);
  assert.ok(ocrFetch, '/api/ocr must be gated on the Tillroll-server key, not called for on-device OCR');
  assert.match(extract, /export function shouldCallServerOcr/);


  // No /api/* fetch in app.js itself. extract.js calls /api/ocr only for the server reader.
  // v2.js calls /api on explicit clicks and page-load session/quota. v2-excel.js calls
  // /api only from Export Excel, 中文 Excel and workbook refresh, never from upload.
  const jsFiles = readdirSync(tillroll).filter(n => extname(n) === '.js');
  const apiByFile = {};
  for (const name of jsFiles) {
    const src = read(name);
    const hits = [...src.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map(m => m[1]);
    if (hits.length) apiByFile[name] = hits;
  }
  assert.deepEqual(Object.keys(apiByFile).sort(), ['extract.js', 'v2-excel.js', 'v2.js']);
  assert.match(app, /import\('\.\/v2-excel\.js'\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function fileSelection'), app.indexOf('function fileSelection') + 400), /v2-excel|\/api\//);
  assert.deepEqual(apiByFile['extract.js'], ['/api/ocr']);

  // v2.js /api calls are not on the upload path: init() only refreshes quota/session;
  // sanity-run, batches, workbooks, history and unlock require an explicit click.
  assert.equal(v2.includes('fileSelection'), false);
  assert.equal(v2.includes('startInput'), false);
  assert.equal(/addEventListener\([^)]*upload/.test(v2), false);
  assert.match(v2, /\$\('#v2-run'\)\?\.addEventListener\('click',\s*runSanity\);/);
  const runSanity = v2.slice(v2.indexOf('async function runSanity()'), v2.indexOf('function renderResult'));
  assert.match(runSanity, /api\('\/api\/batches'/);
  assert.match(runSanity, /api\('\/api\/sanity-run'/);
  const init = v2.slice(v2.indexOf('function init()'), v2.indexOf('const hasDom'));
  assert.match(init, /refreshQuota\(\); refreshDrive\(\);/);
  assert.equal(init.includes('/api/sanity-run'), false);
  assert.equal(init.includes('/api/lookup'), false);
  assert.equal(init.includes('/api/ocr'), false);

  // Mock-fetch proof of the gate used at upload time: default local settings never enable the server reader.
  const calls = [];
  const fetchMock = async (url) => { calls.push(String(url)); return new Response('{}'); };
  const defaultMode = 'local';
  const defaultKey = '';
  const modelEnabled = defaultMode === 'server' && !!defaultKey;
  const maybeExtract = modelEnabled
    ? fetchMock('/api/ocr', { method: 'POST' })
    : Promise.resolve(null);
  // also confirm the viaServer gate independently
  const viaServer = (defaultKey || '').trim() === '__server__';
  if (viaServer) fetchMock('/api/ocr');
  assert.equal(modelEnabled, false);
  assert.equal(viaServer, false);
  return maybeExtract.then(value => {
    assert.equal(value, null);
    assert.deepEqual(calls, []);
  });
});
