import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeZip } from '../test-support/zip.mjs';
import { openZip } from '../src/zip.mjs';

test('reads stored and deflated entries', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'signoff-zip-')), 'x.evidence');
  writeFileSync(p, makeZip([['run.yaml', 'status: failed\n', false], ['tests/a/result.yaml', 'status: failed\n'.repeat(50), true]]));
  const z = openZip(p);
  assert.deepEqual(z.names(), ['run.yaml', 'tests/a/result.yaml']);
  assert.equal(z.text('run.yaml'), 'status: failed\n');
  assert.equal(z.text('tests/a/result.yaml'), 'status: failed\n'.repeat(50));
  assert.equal(z.text('missing'), null);
});
