// The ledger is Signoff's memory: every round Kane ran, what it found, and
// what the agent was told. The viewer reads it; receipts are written from it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

export const LEDGER = '.signoff/ledger.ndjson';
export const LIVE = '.signoff/live.json';

export function appendLedger(root, entry) {
  const p = join(root, LEDGER);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export function readLedger(root) {
  const p = join(root, LEDGER);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** live.json is rewritten atomically so the viewer never reads half a file. */
export function writeLive(root, live) {
  const p = join(root, LIVE);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...live, updated: new Date().toISOString() }, null, 2));
  renameSync(tmp, p);
}

export function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

const SKIP_DIRS = /^(\.git|node_modules|\.signoff|\.testmuai|\.claude|dist|build|\.next|coverage)(\/|$)|(^|\/)(output-[^/]+|helper-output-[^/]+)(\/|$)/;

/** Content fingerprint of the project's code (what Kane is signing off on). */
export function fingerprint(root) {
  let files = [];
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { files = []; }
  const h = createHash('sha256');
  for (const f of files.sort()) {
    if (SKIP_DIRS.test(f)) continue;
    try { h.update(f + '\0'); h.update(readFileSync(join(root, f))); } catch { /* deleted */ }
  }
  return h.digest('hex').slice(0, 16);
}

export function gitHead(root) {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
