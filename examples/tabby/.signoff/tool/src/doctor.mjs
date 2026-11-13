// `kane-signoff doctor`: is everything Signoff needs in place? One line per check,
// each with the command that fixes it.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, listSpecs } from './config.mjs';
import { checkLock } from './lock.mjs';
import { kaneBin } from './kane.mjs';
import { isUp } from './server.mjs';
import { gitHead } from './ledger.mjs';

const isWin = process.platform === 'win32';

function kane(args) {
  const bin = kaneBin();
  // Windows: the npm shim is a .cmd file and needs a shell.
  const r = isWin
    ? spawnSync(`"${bin}" ${args.join(' ')}`, { shell: true, encoding: 'utf8', timeout: 30_000, windowsHide: true })
    : spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export async function doctor(root) {
  const checks = [];
  const add = (label, ok, detail, fix, warn = false) => checks.push({ label, ok: !!ok, detail, fix, warn: !ok && warn });
  const run = existsSync(join(root, 'package.json')) ? 'npm run signoff' : 'node .signoff/tool/bin/kane-signoff.mjs';

  const major = Number(process.versions.node.split('.')[0]);
  add('Node 18 or newer', major >= 18, `v${process.versions.node}`, 'install a current Node from nodejs.org');

  const version = kane(['--version']);
  add('Kane CLI installed', version.ok, version.ok ? version.out.trim().split('\n')[0] : 'not found on PATH', 'npm install -g @testmuai/kane-cli');
  if (version.ok) {
    const who = kane(['whoami']);
    add('Kane CLI signed in', who.ok && /authenticated/i.test(who.out) && !/not authenticated/i.test(who.out), null, 'kane-cli login');
  }

  let cfg = null;
  try { cfg = loadConfig(root); add('signoff.config.json', true, `app at ${cfg.url}${cfg.start ? `, started with \`${cfg.start}\`` : ', started by you'}`); }
  catch (err) { add('signoff.config.json', false, err.message, 'fix the JSON, or run init again with --force'); }

  if (cfg) {
    const specs = listSpecs(root, cfg);
    add('Specs', specs.length > 0, specs.length ? `${specs.length} in ${cfg.specs}/` : `no *_test.md files in ${cfg.specs}/`, `write one in ${cfg.specs}/ (one "##" heading per step)`);
    const lock = checkLock(root, cfg);
    if (lock.missingLock) add('Specs locked', false, 'the agent could still edit them', `${run} lock`, true);
    else add('Specs locked', lock.ok, lock.ok ? `signed ${lock.lockedAt}` : `differ from the signed ones: ${[...lock.changed, ...lock.added, ...lock.removed].join(', ')}`, `${run} lock   (if you changed them on purpose)`);

    const up = await isUp(cfg.url, 1500);
    if (cfg.start) add('App port free', !up, up ? `something is already answering at ${cfg.url}; Signoff starts the app itself and will refuse to test a server it did not start` : cfg.url, 'stop the server that is using that port');
    else add('App running', up, up ? cfg.url : `nothing answers at ${cfg.url}`, 'start your app, or add a "start" command to signoff.config.json', true);
    if (cfg.cdpEndpoint) add('Node 22 for "cdpEndpoint"', major >= 22, `v${process.versions.node}`, 'use Node 22+, or remove "cdpEndpoint"');
  }

  add('Gate installed in the project', existsSync(join(root, '.signoff', 'tool', 'bin', 'kane-signoff.mjs')), '.signoff/tool/', 'npx github:Automationbot24x7/kane-signoff init');
  let hooks = '';
  try { hooks = readFileSync(join(root, '.claude', 'settings.json'), 'utf8'); } catch { /* none */ }
  const has = (cmd) => new RegExp(`kane-signoff\\.mjs\\\\?"? ${cmd}\\b`).test(hooks);
  add('Stop hook (the gate)', has('gate'), '.claude/settings.json', 'npx github:Automationbot24x7/kane-signoff init');
  add('PreToolUse hook (the guard)', has('guard'), '.claude/settings.json', 'npx github:Automationbot24x7/kane-signoff init');
  add('UserPromptSubmit hook (skips turns that change no code)', has('mark'), '.claude/settings.json', 'npx github:Automationbot24x7/kane-signoff init', true);

  add('Gate switched on', !existsSync(join(root, '.signoff', 'off')), null, `${run} on`, true);
  add('Git repository', gitHead(root) !== null, 'receipts carry the commit', 'git init && git commit   (optional)', true);
  return checks;
}
