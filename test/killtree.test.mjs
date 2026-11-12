import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The real failure: the hook process exits right after stopping the app.
// Run stopServer in a child process that exits immediately, then check the app is gone.
test('the app is stopped even when the gate process exits straight away', async () => {
  const root = mkdtempSync(join(tmpdir(), 'signoff-kill-'));
  const port = 43000 + Math.floor(Math.random() * 1000);
  writeFileSync(join(root, 'server.js'), `require('http').createServer((q,a)=>a.end('hi')).listen(${port})`);
  const srv = new URL('../src/server.mjs', import.meta.url).href;
  const start = `const {ensureServer}=await import(${JSON.stringify(srv)}); const r=await ensureServer(${JSON.stringify(root)},{url:'http://localhost:${port}',start:'node server.js',readyTimeout:15}); if(!r.ok) process.exit(3);`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', start], { stdio: 'ignore' }).status, 0);
  const stop = `const {stopServer}=await import(${JSON.stringify(srv)}); stopServer(${JSON.stringify(root)}); process.exit(0);`;
  spawnSync(process.execPath, ['--input-type=module', '-e', stop], { stdio: 'ignore' });
  let up = true;
  for (let i = 0; i < 20 && up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://localhost:${port}`).then(() => true, () => false);
  }
  assert.equal(up, false);
});
