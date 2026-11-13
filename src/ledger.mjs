// The ledger is Signoff's memory: every round Kane ran, what it found, and
// what the agent was told. The viewer reads it; receipts are written from it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * live.json is rewritten atomically so the viewer never reads half a file.
 * It is only a progress display, so it must never break the gate: on Windows a rename
 * can fail for a moment (EPERM/EBUSY) while a viewer or a virus scanner has the file open.
 */
export function writeLive(root, live) {
  try {
    const p = join(root, LIVE);
    mkdirSync(dirname(p), { recursive: true });
    const data = JSON.stringify({ ...live, updated: new Date().toISOString() }, null, 2);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    for (let i = 0; i < 8; i++) {
      try { renameSync(tmp, p); return; }
      catch (err) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err; pause(25 * (i + 1)); }
    }
    writeFileSync(p, data);
    rmSync(tmp, { force: true });
  } catch { /* best effort: a stale progress display is better than a broken gate */ }
}

export function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

const SKIP_DIRS = /^(\.git|node_modules|\.signoff|\.testmuai|\.claude|dist|build|\.next|coverage)(\/|$)|(^|\/)(output-[^/]+|helper-output-[^/]+)(\/|$)/;
const SKIP_ANYWHERE = new Set(['.git', 'node_modules', '.DS_Store']);
const MAX_WALK = 20_000;

/** Every file under root, for projects git cannot list (no repository yet, or an ignored folder). */
function walkFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_WALK || SKIP_ANYWHERE.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP_DIRS.test(r)) continue;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

/** The files Kane is signing off on: what git tracks or would track, or every file if git cannot say. */
export function codeFiles(root) {
  let files = [];
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean).filter((f) => !SKIP_DIRS.test(f));
  } catch { files = []; }
  // Not a git repository (a freshly scaffolded project), or a folder git ignores: without this
  // the fingerprint would be the same for every version of the code, and one pass would
  // sign off everything after it.
  if (!files.length) files = walkFiles(root);
  return files.sort();
}

/** Content fingerprint of the project's code (what Kane is signing off on). */
export function fingerprint(root) {
  const h = createHash('sha256');
  for (const f of codeFiles(root)) {
    try { const data = readFileSync(join(root, f)); h.update(f + '\0'); h.update(data); } catch { /* deleted, or a folder */ }
  }
  return h.digest('hex').slice(0, 16);
}

export function gitHead(root) {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
