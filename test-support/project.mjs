// A throwaway project for the gate tests: a tiny app, one spec, the config, and the
// stand-in Kane CLI on the path Signoff looks at.
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isUp } from '../src/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A port nothing is listening on. */
export const freePort = () => new Promise((resolve) => {
  const s = http.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Point Signoff at the stand-in Kane CLI (a .cmd shim on Windows, a shell script elsewhere). */
export function useFakeKane() {
  const dir = mkdtempSync(join(tmpdir(), 'signoff-fakekane-'));
  const fake = join(here, 'fake-kane.mjs');
  let shim;
  if (process.platform === 'win32') {
    shim = join(dir, 'kane-cli.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    shim = join(dir, 'kane-cli');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  process.env.KANE_CLI_BIN = shim;
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.SIGNOFF_SKIP;
  return shim;
}

export async function makeProject({ page = 'TOTAL 120', spec = 'EXPECT: TOTAL 108', config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'signoff-gate-'));
  const port = await freePort();
  const url = `http://localhost:${port}`;
  mkdirSync(join(root, 'public'));
  mkdirSync(join(root, 'signoff'));
  writeFileSync(join(root, 'server.js'), `const http = require('http'); const fs = require('fs'); const path = require('path');
http.createServer((q, a) => { a.writeHead(200, { 'content-type': 'text/html' }); a.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))); }).listen(${port});
`);
  writeFileSync(join(root, 'signoff.config.json'), JSON.stringify({ url, start: 'node server.js', specs: 'signoff', maxRounds: 3, readyTimeout: 30, specTimeout: 30, ...config }, null, 2) + '\n');
  const p = {
    root, port, url,
    page: (html) => writeFileSync(join(root, 'public', 'index.html'), `<!doctype html><h1>${html}</h1>\n`),
    spec: (text, name = 'total_test.md') => writeFileSync(join(root, 'signoff', name), `---\nurl: ${url}\n---\n\n# Total\n\n## Check the page\n${text}\n`),
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel) => existsSync(join(root, rel)),
    state: () => JSON.parse(readFileSync(join(root, '.signoff', 'state', 'gate.json'), 'utf8')),
    ledger: () => (existsSync(join(root, '.signoff', 'ledger.ndjson')) ? readFileSync(join(root, '.signoff', 'ledger.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    kaneCalls: () => (existsSync(join(root, '.testmuai', 'fake-kane-calls')) ? readFileSync(join(root, '.testmuai', 'fake-kane-calls'), 'utf8').split('\n').filter(Boolean).length : 0),
    /** The app Signoff started must be gone again shortly after the gate returns. */
    appStopped: async () => { for (let i = 0; i < 40; i++) { if (!(await isUp(url, 400))) return true; await new Promise((r) => setTimeout(r, 250)); } return false; },
  };
  p.page(page);
  p.spec(spec);
  return p;
}
