// Runs Kane CLI in agent mode and reads its NDJSON stream.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';

/** Resolve the kane-cli executable (global npm install puts a .cmd shim on Windows). */
export function kaneBin() {
  if (process.env.KANE_CLI_BIN) return process.env.KANE_CLI_BIN;
  // Hooks can run with a thinner PATH than your terminal: look where npm puts global shims.
  const onPath = (process.env.PATH ?? '').split(isWin ? ';' : ':').some((d) => d && existsSync(join(d, isWin ? 'kane-cli.cmd' : 'kane-cli')));
  if (!onPath) {
    const candidates = isWin
      ? [join(process.env.APPDATA ?? '', 'npm', 'kane-cli.cmd')]
      : ['/opt/homebrew/bin/kane-cli', '/usr/local/bin/kane-cli', join(process.env.HOME ?? '', '.npm-global', 'bin', 'kane-cli')];
    const found = candidates.find((c) => existsSync(c));
    if (found) return found;
  }
  return 'kane-cli';
}

function quote(arg) {
  if (!isWin) return arg;
  // cmd.exe quoting for the .cmd shim: wrap in double quotes, double any inner quotes.
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Spawn kane-cli with args, parse NDJSON lines from stdout.
 * onEvent(evt) is called for every JSON line. Resolves { code, events, stderr }.
 */
export function runKane(args, { cwd, onEvent, timeoutMs = 15 * 60_000, env } = {}) {
  return new Promise((resolve) => {
    // Windows: the npm shim is a .cmd file, which needs a shell; pass one pre-quoted string.
    const child = spawn(isWin ? [kaneBin(), ...args].map(quote).join(' ') : kaneBin(), isWin ? [] : args, {
      cwd,
      shell: isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    const events = [];
    let buf = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const evt = JSON.parse(line);
          events.push(evt);
          onEvent?.(evt);
        } catch { /* not JSON: skip, per the stream contract */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    const timer = setTimeout(() => { killTree(child.pid); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim().startsWith('{')) { try { const e = JSON.parse(buf.trim()); events.push(e); onEvent?.(e); } catch {} }
      resolve({ code: code ?? 3, events, stderr });
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 2, events, stderr: String(err) }); });
  });
}

/** Kill a process and its children, and wait for it: the hook exits right after, so this must be synchronous. */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    else process.kill(-pid, 'SIGTERM');
  } catch { try { process.kill(pid); } catch {} }
}

/** Run one _test.md file. Returns a normalized result. */
export async function runSpec(specPath, { cwd, url, headless, onEvent, timeoutMs }) {
  const args = ['testmd', 'run', specPath, '--agent'];
  if (url) args.push('--url', url);
  if (headless) args.push('--headless');
  const started = Date.now();
  const { code, events, stderr } = await runKane(args, { cwd, onEvent, timeoutMs });
  const done = [...events].reverse().find((e) => e.type === 'test_md_done');
  const runEnds = events.filter((e) => e.type === 'run_end');
  const credits = runEnds.reduce((s, e) => s + (Number(e.credits_consumed ?? e.credits) || 0), 0);
  const status = code === 0 ? 'passed' : code === 1 ? 'failed' : code === 3 ? 'timeout' : 'error';
  return {
    spec: specPath,
    code,
    status,
    overall: done?.overall_status ?? null,
    duration: (Date.now() - started) / 1000,
    credits: Math.round(credits * 10) / 10,
    shareUrl: done?.share_url ?? runEnds.find((e) => e.test_url)?.test_url ?? null,
    sessionId: done?.session_id ?? null,
    events,
    stderrTail: stderr.split('\n').filter(Boolean).slice(-12).join('\n'),
    evidenceHint: (stderr.match(/evidence serve\s+[`"]?([^\s`"]+\.evidence)/) || [])[1] ?? null,
  };
}

/** Newest .evidence file in <cwd>/.testmuai/evidence created after `since` (ms). */
export function newestEvidence(cwd, since = 0) {
  const dir = join(cwd, '.testmuai', 'evidence');
  if (!existsSync(dir)) return null;
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.evidence')) continue;
    const p = join(dir, f);
    const m = statSync(p).mtimeMs;
    if (m >= since - 2000 && (!best || m > best.m)) best = { p, m };
  }
  return best?.p ?? null;
}
