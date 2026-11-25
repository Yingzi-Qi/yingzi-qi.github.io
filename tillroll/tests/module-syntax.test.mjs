import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every tillroll/*.js file parses as an ES module', () => {
  const files = readdirSync(root).filter(name => name.endsWith('.js')).sort();
  assert.ok(files.length > 0);
  const failures = [];
  for (const name of files) {
    const source = readFileSync(join(root, name));
    const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: source,
      encoding: 'utf8',
    });
    if (checked.status !== 0) failures.push(name + '\n' + (checked.stderr || checked.stdout));
  }
  assert.deepEqual(failures, [], 'Module parse failed:\n' + failures.join('\n'));
});
