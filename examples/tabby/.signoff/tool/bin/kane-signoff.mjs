#!/usr/bin/env node
// Signoff: your coding agent is not done until Kane CLI signs off.
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gate, readStdinJson } from '../src/gate.mjs';
import { guard } from '../src/guard.mjs';
import { init } from '../src/init.mjs';
import { findRoot, loadConfig, listSpecs } from '../src/config.mjs';
import { writeLock, checkLock } from '../src/lock.mjs';
import { readJson } from '../src/ledger.mjs';
import { serveViewer } from '../src/view.mjs';
import { stopServer } from '../src/server.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : undefined; };
const say = (s = '') => process.stderr.write(s + '\n');
const need = () => { const r = findRoot(); if (!r) { say('No signoff.config.json here. Run `kane-signoff init` first.'); process.exit(2); } return r; };

const HELP = `kane-signoff: your coding agent is not done until Kane CLI signs off.

  init [--url <url>] [--start "<cmd>"]   wire Signoff into this project (hooks, config, starter spec)
  lock                                   sign the current specs as the definition of done
  check                                  run the specs now, like the hook does (exit 0 pass, 1 fail)
  view [--port 4747]                     open the live round-by-round timeline
  status                                 show config, specs, lock and last result
  off | on                               pause or resume the gate for this project

  gate | guard                           (used by the agent's hooks; read JSON on stdin)
`;

switch (cmd) {
  case 'gate': {
    // Claude Code Stop hook. Never crash the agent's session: any internal error lets it stop.
    const input = await readStdinJson();
    try {
      const r = await gate({ mode: 'hook', input });
      if (r.decision === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: r.reason }));
      else if (r.message) process.stdout.write(JSON.stringify({ systemMessage: r.message }));
    } catch (err) {
      process.stdout.write(JSON.stringify({ systemMessage: `Signoff hit an internal error and did not block: ${err.message}` }));
    }
    process.exit(0);
  }
  case 'guard': {
    const input = await readStdinJson();
    try { const r = guard(input); if (r) process.stdout.write(JSON.stringify(r)); } catch { /* never block on our own bug */ }
    process.exit(0);
  }
  case 'init': {
    const root = process.cwd();
    for (const line of init(root, { url: flag('url'), start: flag('start'), force: !!flag('force') })) say(`  ✓ ${line}`);
    const run = existsSync(join(root, 'package.json')) ? 'npm run signoff' : 'node .signoff/tool/bin/kane-signoff.mjs';
    say(`\nNext:\n  1. Describe what "done" means in signoff/*_test.md (plain English, one ## heading per step).\n  2. Sign the specs:       ${run} lock\n  3. Ask your agent for a change. It cannot finish until Kane passes the specs.\n  Watch the rounds live:   ${run} view`);
    break;
  }
  case 'lock': {
    const root = need();
    const lock = writeLock(root, loadConfig(root));
    say(`Locked ${Object.keys(lock.files).length} files into .signoff/spec-lock.json. Commit it with the specs.`);
    break;
  }
  case 'check': {
    const root = need();
    const r = await gate({ mode: 'cli', input: { cwd: root, session_id: 'manual' }, force: true, log: (m) => say(`  · ${m}`) });
    say(r.decision === 'block' ? r.reason : r.message ?? 'ok');
    // reset the manual session so repeated checks don't hit the round cap
    const sp = join(root, '.signoff/state/gate.json'); const st = readJson(sp, null);
    if (st?.sessions?.manual) { delete st.sessions.manual; writeFileSync(sp, JSON.stringify(st, null, 2)); }
    process.exit(r.decision === 'block' ? 1 : 0);
  }
  case 'view': {
    const root = need();
    await serveViewer(root, { port: Number(flag('port')) || 4747, open: !flag('no-open') });
    break;
  }
  case 'status': {
    const root = need();
    const cfg = loadConfig(root);
    const lock = checkLock(root, cfg);
    const st = readJson(join(root, '.signoff/state/gate.json'), {});
    say(`app:    ${cfg.url}${cfg.start ? `  (start: ${cfg.start})` : ''}`);
    say(`specs:  ${listSpecs(root, cfg).join(', ') || '(none)'}`);
    say(`lock:   ${lock.missingLock ? 'not locked (run the `lock` command)' : lock.ok ? `ok, locked ${lock.lockedAt}` : `CHANGED: ${[...lock.changed, ...lock.added, ...lock.removed].join(', ')}`}`);
    say(`gate:   ${existsSync(join(root, '.signoff/off')) ? 'OFF' : 'on'}, max ${cfg.maxRounds} rounds`);
    if (st.lastPass) say(`last signed off: ${st.lastPass.when} (${st.lastPass.passed}/${st.lastPass.total} specs)`);
    break;
  }
  case 'off': { const root = need(); mkdirSync(join(root, '.signoff'), { recursive: true }); writeFileSync(join(root, '.signoff/off'), ''); stopServer(root); say('Signoff paused for this project.'); break; }
  case 'on': { const root = need(); rmSync(join(root, '.signoff/off'), { force: true }); say('Signoff is on.'); break; }
  default: say(HELP);
}
