// Spec lock: a human signs the specs once; the gate refuses to sign off if the
// agent changed them. This stops the cheapest "fix" of all: weakening the test.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_FILE, listSpecs } from './config.mjs';

export const LOCK_FILE = '.signoff/spec-lock.json';

const hash = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

function lockedFiles(root, cfg) {
  return [...listSpecs(root, cfg), CONFIG_FILE];
}

export function writeLock(root, cfg) {
  const files = {};
  for (const f of lockedFiles(root, cfg)) files[f] = hash(readFileSync(join(root, f), 'utf8'));
  const lock = { lockedAt: new Date().toISOString(), files };
  const p = join(root, LOCK_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

/** Returns { ok, missingLock, changed: [], added: [], removed: [] } */
export function checkLock(root, cfg) {
  const p = join(root, LOCK_FILE);
  if (!existsSync(p)) return { ok: true, missingLock: true, changed: [], added: [], removed: [] };
  const lock = JSON.parse(readFileSync(p, 'utf8'));
  const now = lockedFiles(root, cfg);
  const changed = [], added = [], removed = [];
  for (const f of now) {
    if (!(f in lock.files)) added.push(f);
    else if (hash(readFileSync(join(root, f), 'utf8')) !== lock.files[f]) changed.push(f);
  }
  for (const f of Object.keys(lock.files)) if (!now.includes(f) && !existsSync(join(root, f))) removed.push(f);
  return { ok: !changed.length && !added.length && !removed.length, missingLock: false, changed, added, removed, lockedAt: lock.lockedAt };
}
