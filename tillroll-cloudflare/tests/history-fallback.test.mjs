import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const MAIN = '5d6a7c6ab613bbdcfc979f1f2474877d4345ec7f';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tillrollDir = join(root, 'tillroll');
const indexHtml = readFileSync(join(tillrollDir, 'index.html'), 'utf8');

function sha256(buf) {
  return execFileSync('sha256sum', { input: buf, encoding: 'utf8' }).split(/\s+/)[0];
}

test(`reading-policy.html and receipt-policy.js are byte-identical to ${MAIN}`, () => {
  const repo = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  for (const rel of ['tillroll/reading-policy.html', 'tillroll/receipt-policy.js']) {
    const work = readFileSync(join(repo, rel));
    const expected = execFileSync('git', ['-C', repo, 'show', `${MAIN}:${rel}`]);
    assert.equal(work.compare(expected), 0, `${rel} must be byte-identical to ${MAIN}`);
    assert.equal(sha256(work), sha256(expected));
  }
});

test('中文 Excel, policy link, and exactly one Reading history control stay in the page', () => {
  const actions = indexHtml.match(/<div class="actions">([\s\S]*?)<\/div><\/div>\s*<div id="summary"/);
  assert.ok(actions, 'workspace actions row missing');
  const row = actions[1];
  assert.match(row, /id="excel-china"/);
  assert.doesNotMatch(row, /id="history"/); // history is in the header, not the workspace actions
  assert.match(indexHtml, /id="history"/);
  assert.match(indexHtml, /href="\.\/reading-policy\.html"/);
  assert.match(indexHtml, /id="history-dialog"/);
  assert.match(indexHtml, /id="history-list"/);
  assert.match(indexHtml, /id="history-server-list"/);
  assert.match(indexHtml, /id="history-status"/);
  assert.doesNotMatch(indexHtml, /id="v2-history-dialog"|id="v2-history"|id="landing-history"/);
  const historyButtons = [...indexHtml.matchAll(/<button\b[^>]*id="history"[^>]*>[\s\S]*?<\/button>/g)].map(m => m[0]);
  assert.equal(historyButtons.length, 1, `expected one #history button, found ${historyButtons.length}`);
  assert.match(historyButtons[0], />Reading history</);
  const visibleHistoryLabels = [...indexHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(label => /^Reading history$/i.test(label));
  assert.equal(visibleHistoryLabels.length, 1, `expected one visible Reading history label, found ${visibleHistoryLabels}`);
});
