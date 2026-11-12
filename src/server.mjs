// Makes sure the app under test is answering before Kane opens it.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from './kane.mjs';

const isWin = process.platform === 'win32';
const PID_FILE = '.signoff/state/server.pid';

export async function isUp(url, timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    clearTimeout(t);
    return r.status > 0 && r.status < 500;
  } catch { return false; }
}

export function stopServer(root) {
  const p = join(root, PID_FILE);
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, 'utf8'));
  killTree(pid);
  rmSync(p, { force: true });
  return true;
}

/**
 * Ensure the app is reachable. If cfg.start is set we own the process:
 * restart it each round when cfg.restart is true (servers without hot reload).
 * Returns { ok, started, log }.
 */
export async function ensureServer(root, cfg, log = () => {}) {
  const owned = existsSync(join(root, PID_FILE));
  if (cfg.start && cfg.restart && owned) {
    log('restarting app');
    stopServer(root);
    await waitDown(cfg.url, 8000);
  } else if (await isUp(cfg.url)) {
    return { ok: true, started: false };
  }
  if (!cfg.start) return { ok: false, started: false, reason: `Nothing is answering at ${cfg.url} and no "start" command is configured.` };

  mkdirSync(join(root, '.signoff', 'state'), { recursive: true });
  const logPath = join(root, '.signoff', 'server.log');
  const out = openSync(logPath, 'w');
  log(`starting app: ${cfg.start}`);
  const child = spawn(cfg.start, { cwd: root, shell: true, detached: !isWin, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  writeFileSync(join(root, PID_FILE), String(child.pid));

  const deadline = Date.now() + cfg.readyTimeout * 1000;
  while (Date.now() < deadline) {
    if (await isUp(cfg.url)) return { ok: true, started: true };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n') : '';
  return { ok: false, started: true, appCrashed: true, reason: `The app did not answer at ${cfg.url} within ${cfg.readyTimeout}s after running \`${cfg.start}\`.`, log: tail };
}

async function waitDown(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && (await isUp(url, 800))) await new Promise((r) => setTimeout(r, 300));
}
