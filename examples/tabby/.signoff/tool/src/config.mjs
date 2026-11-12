// Loads signoff.config.json from the project root.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const CONFIG_FILE = 'signoff.config.json';

export const DEFAULTS = {
  url: 'http://localhost:3000',   // where your app runs
  start: null,                    // command that starts your app (optional if you run it yourself)
  specs: 'signoff',               // folder of Kane _test.md specs
  maxRounds: 4,                   // how many times Kane may send the agent back before giving up
  headless: true,                 // false shows the real Chrome window while Kane works
  blind: false,                   // true hides the specs from the agent: it learns only from Kane's failures
  cdpEndpoint: null,              // e.g. "http://127.0.0.1:9222": run Kane in a Chrome you started (to watch or record it)
  readyTimeout: 60,               // seconds to wait for the app to answer
  specTimeout: 900,               // seconds per spec
  // The agent may read these but never write them: the specs, the gate's config and
  // its own state (so it cannot switch the gate off or forge a pass).
  protect: ['signoff/**', 'signoff.config.json', '.signoff/**', '.claude/settings.json', '.claude/settings.local.json'],
};

export function findRoot(start = process.cwd()) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = join(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function loadConfig(root) {
  const raw = JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8'));
  const specs = (raw.specs ?? DEFAULTS.specs).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return { ...DEFAULTS, ...raw, specs, protect: [...new Set([...DEFAULTS.protect, `${specs}/**`, ...(raw.protect ?? [])])] };
}

/** All *_test.md files under the specs folder, sorted, as paths relative to root. */
export function listSpecs(root, cfg) {
  const dir = join(root, cfg.specs);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (f.startsWith('output-') || f.startsWith('.') || f.startsWith('helper-output-')) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('_test.md')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Tiny glob: supports **, * and literal paths, matched against forward-slash relative paths. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function isProtected(relPath, cfg) {
  const p = relPath.split('\\').join('/').replace(/^\.\//, '');
  return cfg.protect.some((g) => globToRegex(g).test(p));
}
