// Spec lock: a human signs the specs once; the gate refuses to sign off if the
// agent changed them. This stops the cheapest "fix" of all: weakening the test.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_FILE, listSpecs } from './config.mjs';

export const LOCK_FILE = '.signoff/spec-lock.json';
// A private copy of exactly what was signed, so the gate can put it back (git-ignored state).
const SEALED = '.signoff/state/sealed';

const hash = (text) => createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

function lockedFiles(root, cfg) {
  return [...listSpecs(root, cfg), CONFIG_FILE];
}

export function writeLock(root, cfg) {
  const files = {};
  rmSync(join(root, SEALED), { recursive: true, force: true });
  for (const f of lockedFiles(root, cfg)) {
    const text = readFileSync(join(root, f), 'utf8');
    files[f] = hash(text);
    mkdirSync(dirname(join(root, SEALED, f)), { recursive: true });
    writeFileSync(join(root, SEALED, f), text);
  }
  const lock = { lockedAt: new Date().toISOString(), files };
  const p = join(root, LOCK_FILE);
  const body = JSON.stringify(lock, null, 2) + '\n';
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  writeFileSync(join(root, SEALED, 'spec-lock.json'), body);
  return lock;
}

/** Is the lock file committed? Then a missing lock was deleted, not "never created". */
function lockIsTracked(root) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', LOCK_FILE], { cwd: root, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** The committed version of a file, or null. */
function committed(root, file) {
  try {
    return execFileSync('git', ['show', `HEAD:./${file}`], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch { return null; }
}

function readLock(root) {
  try {
    const lock = JSON.parse(readFileSync(join(root, LOCK_FILE), 'utf8'));
    return lock && typeof lock.files === 'object' && lock.files ? lock : null;
  } catch { return null; }
}

/** Returns { ok, missingLock, deletedLock, changed: [], added: [], removed: [] } */
export function checkLock(root, cfg) {
  const p = join(root, LOCK_FILE);
  if (!existsSync(p)) {
    // Deleting the lock must not unlock the specs: if git or Signoff's own copy knows the file, it was there.
    if (existsSync(join(root, SEALED, 'spec-lock.json')) || lockIsTracked(root)) return { ok: false, missingLock: false, deletedLock: true, changed: [], added: [], removed: [LOCK_FILE] };
    return { ok: true, missingLock: true, changed: [], added: [], removed: [] };
  }
  const lock = readLock(root);
  // An unreadable lock is a changed lock, not a missing one.
  if (!lock) return { ok: false, missingLock: false, changed: [LOCK_FILE], added: [], removed: [] };
  const now = lockedFiles(root, cfg);
  const changed = [], added = [], removed = [];
  for (const f of now) {
    if (!(f in lock.files)) added.push(f);
    else if (hash(readFileSync(join(root, f), 'utf8')) !== lock.files[f]) changed.push(f);
  }
  for (const f of Object.keys(lock.files)) if (!now.includes(f) && !existsSync(join(root, f))) removed.push(f);
  return { ok: !changed.length && !added.length && !removed.length, missingLock: false, changed, added, removed, lockedAt: lock.lockedAt };
}

/**
 * Put the signed versions back: changed and removed files are rewritten from Signoff's own
 * copy (or from the last commit, when it matches the signed hash), files that were added are
 * moved out. Whatever was there is kept in `keepDir`, so nothing is lost.
 * Returns { restored: [], failed: [] }.
 */
export function restoreLocked(root, problem, keepDir) {
  const restored = [], failed = [];
  const keep = (f) => {
    const cur = join(root, f);
    if (!existsSync(cur)) return;
    mkdirSync(dirname(join(keepDir, f)), { recursive: true });
    try { renameSync(cur, join(keepDir, f)); } catch { writeFileSync(join(keepDir, f), readFileSync(cur)); rmSync(cur, { force: true }); }
  };
  const put = (f, text) => { keep(f); mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); restored.push(f); };

  // The lock itself first: everything else is checked against it.
  if (problem.deletedLock || problem.changed.includes(LOCK_FILE)) {
    const text = readText(join(root, SEALED, 'spec-lock.json')) ?? committed(root, LOCK_FILE);
    if (text) put(LOCK_FILE, text); else failed.push(LOCK_FILE);
  }
  const lock = readLock(root);
  if (!lock) return { restored, failed: [...new Set([...failed, ...problem.changed, ...problem.removed])] };

  for (const f of [...problem.changed, ...problem.removed]) {
    if (f === LOCK_FILE) continue;
    const want = lock.files[f];
    const text = [readText(join(root, SEALED, f)), committed(root, f)].find((t) => t != null && hash(t) === want);
    if (text != null) put(f, text); else failed.push(f);
  }
  for (const f of problem.added) { keep(f); restored.push(f); }
  return { restored, failed };
}
