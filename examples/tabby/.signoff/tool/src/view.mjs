// `kane-signoff view`: a local page that shows each round live.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readLedger, readJson, LIVE } from './ledger.mjs';
import { loadConfig, listSpecs } from './config.mjs';
import { checkLock } from './lock.mjs';

const VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewer');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8' };

export function serveViewer(root, { port = 4747, open = true } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (url.pathname === '/api/state') {
        const cfg = loadConfig(root);
        const lock = checkLock(root, cfg);
        return send(200, JSON.stringify({
          project: root.split(sep).pop(),
          config: { url: cfg.url, maxRounds: cfg.maxRounds, specs: listSpecs(root, cfg) },
          lock: { locked: !lock.missingLock, ok: lock.ok, lockedAt: lock.lockedAt ?? null, changed: [...(lock.changed ?? []), ...(lock.added ?? []), ...(lock.removed ?? [])] },
          live: readJson(join(root, LIVE), null),
          ledger: readLedger(root).slice(-200),
          receipt: existsSync(join(root, '.signoff', 'RECEIPT.md')) ? readFileSync(join(root, '.signoff', 'RECEIPT.md'), 'utf8') : null,
        }));
      }
      if (url.pathname.startsWith('/rounds/')) {
        // screenshots and reports from .signoff/rounds only
        const base = join(root, '.signoff', 'rounds');
        const p = normalize(join(base, decodeURIComponent(url.pathname.slice('/rounds/'.length))));
        if (!p.startsWith(base + sep) || !existsSync(p) || !statSync(p).isFile()) return send(404, 'not found', 'text/plain');
        return send(200, readFileSync(p), TYPES[extname(p)] ?? 'application/octet-stream');
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const p = normalize(join(VIEWER, file));
      if (!p.startsWith(VIEWER) || !existsSync(p)) return send(404, 'not found', 'text/plain');
      return send(200, readFileSync(p), TYPES[extname(p)] ?? 'application/octet-stream');
    } catch (err) { return send(500, JSON.stringify({ error: err.message })); }
  });
  return new Promise((resolveP) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = `http://localhost:${port}`;
      process.stderr.write(`Signoff timeline: ${addr}  (Ctrl+C to stop)\n`);
      if (open) {
        const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]] : process.platform === 'darwin' ? ['open', [addr]] : ['xdg-open', [addr]];
        try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch {}
      }
      resolveP(server);
    });
  });
}
