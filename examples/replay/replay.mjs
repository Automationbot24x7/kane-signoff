#!/usr/bin/env node
// Replay the recorded run, without a coding agent.
//
// The agent's part is played back from the recording: the files it had written the first
// time it said "done" (attempt-1), and the files after it read Kane's report (attempt-2).
// Everything else is live: Signoff's real hooks, your Kane CLI, a real Chrome browser.
//
//   node examples/replay/replay.mjs           the checkout spec only (about 8 minutes)
//   node examples/replay/replay.mjs --full    all three specs, as in the demo video
//
// It works on a copy in your temp folder and leaves this repository untouched.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const full = process.argv.includes('--full');
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s), dim = (s) => paint('2', s), red = (s) => paint('31', s), green = (s) => paint('32', s);
const say = (s = '') => process.stdout.write(s + '\n');
const rule = (title) => say(`\n${bold(title)}\n${'─'.repeat(Math.min(78, title.length))}`);
const quote = (text) => text.split('\n').map((l) => `  │ ${l}`).join('\n');

// 1. A fresh copy of the demo project, without leftovers from earlier runs.
const project = join(mkdtempSync(join(tmpdir(), 'signoff-replay-')), 'tabby');
const skip = ['.testmuai', join('.signoff', 'state'), join('.signoff', 'rounds'), join('.signoff', 'receipts'), join('.signoff', 'live.json'), join('.signoff', 'ledger.ndjson'), join('.signoff', 'RECEIPT.md'), join('.signoff', 'server.log'), join('.signoff', 'off')];
cpSync(join(here, '..', 'tabby'), project, {
  recursive: true,
  filter: (src) => { const rel = src.slice(join(here, '..', 'tabby').length + 1); return !skip.some((s) => rel === s || rel.startsWith(s + '\\') || rel.startsWith(s + '/')) && !/[\\/]output-[^\\/]+/.test(rel); },
});
if (!full) for (const f of ['split_test.md', 'edge_test.md']) rmSync(join(project, 'signoff', f), { force: true });

const tool = join(project, '.signoff', 'tool', 'bin', 'kane-signoff.mjs');
const env = { ...process.env, CLAUDE_PROJECT_DIR: project };
const cli = (...args) => spawnSync(process.execPath, [tool, ...args], { cwd: project, env, encoding: 'utf8' });

rule('Signoff replay: the recorded run, without the agent');
say(`Project copy   ${project}`);
say(`Specs          ${full ? 'all three (split, edge, checkout), as in the demo video' : 'signoff/checkout_test.md, the one that caught the bug (--full runs all three)'}`);
say(`Played back    the files the agent wrote, from docs/runs/2026-11-13-recorded-take.md`);
say(`Live           Signoff's hooks, your Kane CLI, a real Chrome browser`);

// 2. The human signs the specs (the copy has fewer of them in the short version).
cli('lock');
const doctor = cli('doctor');
if (doctor.status !== 0) {
  say(`\n${red('Not ready yet:')}\n${doctor.stderr}`);
  say('Fix the lines marked ✗ and run the replay again.');
  process.exit(2);
}

// 3. One call to one of Signoff's hooks, exactly as Claude Code makes it: JSON on stdin, JSON on stdout.
const session = `replay-${Date.now().toString(36)}`;
function hook(command, input, { watch = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, command], { cwd: project, env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stdin.end(JSON.stringify({ session_id: session, cwd: project, ...input }));
    // While the gate runs, show what Kane is doing (the same file the live timeline reads).
    const shown = new Map();
    let phase = '';
    const timer = watch && setInterval(() => {
      let live;
      try { live = JSON.parse(readFileSync(join(project, '.signoff', 'live.json'), 'utf8')); } catch { return; }
      if (live.session !== session) return;
      if (live.phase !== phase) { phase = live.phase; say(dim(`  · ${phase}`)); }
      for (const sp of live.specs ?? []) {
        const n = shown.get(sp.spec) ?? 0;
        for (const st of sp.steps.slice(n)) say(dim(`      ${st.status === 'failed' ? red('✗') : st.status === 'passed' ? '✓' : '›'} ${st.text}`));
        shown.set(sp.spec, sp.steps.length);
      }
    }, 1500);
    child.on('close', () => { if (timer) clearInterval(timer); try { resolve(out.trim() ? JSON.parse(out) : {}); } catch { resolve({ raw: out }); } });
  });
}
const write = (attempt) => cpSync(join(here, attempt, 'public'), join(project, 'public'), { recursive: true });
const started = Date.now();

// 4. The request.
rule('The human asks');
say(quote("Build the 'Checkout extras' described at the end of BRIEF.md."));
await hook('mark', { hook_event_name: 'UserPromptSubmit' });

// 5. The agent's first version.
rule('The agent builds the feature and says it is done');
write('attempt-1');
say('Its summary, from the recording:');
say(quote('Coupons: a coupon field. WELCOME10 takes 10% off the bill.\nAny other code shows "That code is not valid." and changes nothing.'));
say('\nThe Stop hook fires. Signoff starts the app and Kane CLI takes the browser:');
const first = await hook('gate', { hook_event_name: 'Stop', stop_hook_active: false }, { watch: true });

if (first.decision !== 'block') {
  rule('Result');
  say(`Kane did not refuse the first version this time${first.systemMessage ? `: ${first.systemMessage}` : '.'}`);
  say('Kane CLI is an AI tester and its runs can differ. In the recorded run, and in 5 of 5 runs of this ticket, it refused here.');
  process.exit(1);
}
rule('Signoff blocks the agent. This is its next instruction, word for word');
say(quote(first.reason));
const shot = (first.reason.match(/open it\): (\S+)/) ?? [])[1];
if (shot && existsSync(join(project, shot))) say(`\nThe screenshot Kane saw: ${join(project, shot)}`);

// 6. The agent's fix.
rule('The agent reads the report and fixes the app');
write('attempt-2');
say('From the recording:');
say(quote("Kane's finding is right: typing an invalid code clears the discount that was already\napplied. The brief says an invalid code \"changes nothing\", so I'll track the last valid\napplied coupon separately from the text in the field."));
say('\nIt tries to finish again. The Stop hook fires:');
const second = await hook('gate', { hook_event_name: 'Stop', stop_hook_active: true }, { watch: true });

rule('Result');
const minutes = Math.round((Date.now() - started) / 6000) / 10;
if (second.decision === 'block') {
  say(red('Kane refused the fixed version too. This is what it reported:'));
  say(quote(second.reason));
  say('\nKane CLI is an AI tester and its runs can differ; in the recorded run this version passed 3 of 3.');
  process.exit(1);
}
say(green(`Round 1: refused (the coupon bug). Round 2: ${second.systemMessage ?? 'allowed'}`));
const receipt = join(project, '.signoff', 'RECEIPT.md');
if (existsSync(receipt)) say(`\n${readFileSync(receipt, 'utf8').trim()}`);
say(`\nTook ${minutes} minutes. Watch both rounds on the timeline:`);
say(`  node "${tool}" view`);
process.exit(/signed off/i.test(second.systemMessage ?? '') ? 0 : 1);
