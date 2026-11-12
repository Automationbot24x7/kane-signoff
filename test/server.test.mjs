import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureServer, stopServer, isUp } from '../src/server.mjs';

const listen = () => new Promise((r) => { const s = http.createServer((q, a) => a.end('ok')).listen(0, () => r(s)); });

test('refuses to test a server it did not start when it has a start command', async () => {
  const other = await listen();
  const url = `http://localhost:${other.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'signoff-srv-'));
  const r = await ensureServer(root, { url, start: 'node server.js', readyTimeout: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.foreign, true);
  other.close();
});

test('uses whatever answers when there is no start command', async () => {
  const other = await listen();
  const url = `http://localhost:${other.address().port}`;
  const r = await ensureServer(mkdtempSync(join(tmpdir(), 'signoff-srv-')), { url, start: null, readyTimeout: 5 });
  assert.equal(r.ok, true);
  other.close();
});

test('starts the app from this folder and stops it again', async () => {
  const probe = await listen(); const port = probe.address().port; probe.close();
  const root = mkdtempSync(join(tmpdir(), 'signoff-srv-'));
  writeFileSync(join(root, 'server.js'), `require('http').createServer((q,a)=>a.end('hi')).listen(${port})`);
  const url = `http://localhost:${port}`;
  const r = await ensureServer(root, { url, start: 'node server.js', readyTimeout: 15 });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  stopServer(root);
  let up = true;
  for (let i = 0; i < 30 && up; i++) { await new Promise((s) => setTimeout(s, 300)); up = await isUp(url, 500); }
  assert.equal(up, false);
});
