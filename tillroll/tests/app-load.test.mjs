import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('app.js passes node --check', () => {
  const file = fileURLToPath(new URL('../app.js', import.meta.url));
  execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'});
  assert.ok(true);
});
