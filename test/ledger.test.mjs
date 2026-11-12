import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeLive } from '../src/ledger.mjs';

test('writeLive writes the progress file', () => {
  const root = mkdtempSync(join(tmpdir(), 'signoff-live-'));
  writeLive(root, { phase: 'checking' });
  assert.equal(JSON.parse(readFileSync(join(root, '.signoff', 'live.json'), 'utf8')).phase, 'checking');
});

test('writeLive never throws, even when the file cannot be replaced', () => {
  const root = mkdtempSync(join(tmpdir(), 'signoff-live-'));
  mkdirSync(join(root, '.signoff', 'live.json'), { recursive: true }); // a directory where the file should be
  assert.doesNotThrow(() => writeLive(root, { phase: 'checking' }));
});

test('writeLive still updates while a reader holds the file open', () => {
  const root = mkdtempSync(join(tmpdir(), 'signoff-live-'));
  writeLive(root, { phase: 'one' });
  const fd = openSync(join(root, '.signoff', 'live.json'), 'r');
  try { writeLive(root, { phase: 'two' }); } finally { closeSync(fd); }
  assert.equal(JSON.parse(readFileSync(join(root, '.signoff', 'live.json'), 'utf8')).phase, 'two');
});
