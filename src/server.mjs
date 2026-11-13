// Makes sure the app under test is answering before Kane opens it.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from './kane.mjs';

const isWin = process.platform === 'win32';
const PID_FILE = '.signoff/state/server.pid';

async function answers(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    return r.status > 0 && r.status < 500;
  } catch { return false; } finally { clearTimeout(t); }
}

/**
 * Is something answering at this URL? "localhost" can mean IPv4 or IPv6, and older Node
 * versions try only one of them, so check both before deciding nothing is there.
 */
export async function isUp(url, timeoutMs = 2500) {
  if (await answers(url, timeoutMs)) return true;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.hostname !== 'localhost') return false;
  for (const host of ['127.0.0.1', '[::1]']) {
    u.hostname = host;
    if (await answers(u.href, Math.min(timeoutMs, 1500))) return true;
  }
  return false;
}

/** PID of the process listening on a TCP port, or null. */
export function portOwner(port) {
  try {
    if (isWin) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().split(/\s+/);
        if (m.length >= 5 && /LISTEN/i.test(m[3]) && m[1].endsWith(`:${port}`)) return Number(m[4]);
      }
      return null;
    }
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.split('\n')[0]) || null;
  } catch { return null; }
}

const portOf = (url) => { const u = new URL(url); return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); };

export function stopServer(root) {
  const p = join(root, PID_FILE);
  if (!existsSync(p)) return false;
  // The file holds the shell's PID and, once the app answered, the PID that owns the port.
  // On Windows the shell can exit and leave the app running, so kill both.
  const pids = readFileSync(p, 'utf8').split(/\s+/).map(Number).filter(Boolean);
  for (const pid of pids.reverse()) killTree(pid);
  rmSync(p, { force: true });
  return true;
}

/**
 * Ensure the app is reachable. With cfg.start, Signoff starts a fresh copy from this
 * folder for every round (and the gate stops it afterwards).
 * Returns { ok, started, log }.
 */
export async function ensureServer(root, cfg, log = () => {}) {
  // No start command: the human runs the app; test whatever answers.
  if (!cfg.start) {
    if (await isUp(cfg.url)) return { ok: true, started: false };
    return { ok: false, started: false, reason: `Nothing is answering at ${cfg.url} and no "start" command is configured.` };
  }
  // With a start command, Kane must test the app from THIS folder, freshly started,
  // never a stale server left on the port by something else.
  if (existsSync(join(root, PID_FILE))) { stopServer(root); await waitDown(cfg.url, 8000); }
  if (await isUp(cfg.url)) {
    return { ok: false, started: false, foreign: true, reason: `Something else is already answering at ${cfg.url}, so Signoff cannot start this app there and be sure Kane tests this code.` };
  }

  mkdirSync(join(root, '.signoff', 'state'), { recursive: true });
  const logPath = join(root, '.signoff', 'server.log');
  const out = openSync(logPath, 'w');
  log(`starting app: ${cfg.start}`);
  const child = spawn(cfg.start, { cwd: root, shell: true, detached: !isWin, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  writeFileSync(join(root, PID_FILE), String(child.pid));

  const deadline = Date.now() + cfg.readyTimeout * 1000;
  while (Date.now() < deadline) {
    if (await isUp(cfg.url)) {
      const owner = portOwner(portOf(cfg.url));
      if (owner && owner !== child.pid) writeFileSync(join(root, PID_FILE), `${child.pid} ${owner}`);
      return { ok: true, started: true };
    }
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
