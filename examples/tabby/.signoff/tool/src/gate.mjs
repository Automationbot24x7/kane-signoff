// The Stop hook. When the coding agent tries to finish, run the Kane specs.
// Pass: let it finish and write a receipt. Fail: block, and hand the agent
// a diagnosis built from Kane's own evidence so it can fix and try again.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONFIG_FILE, findRoot, hookRoot, loadConfig, listSpecs } from './config.mjs';
import { checkLock, restoreLocked } from './lock.mjs';
import { ensureServer, stopServer } from './server.mjs';
import { runSpec, newestEvidence } from './kane.mjs';
import { readEvidence } from './evidence.mjs';
import { clearOrigin } from './cdp.mjs';
import { agentReport, receipt } from './report.mjs';
import { appendLedger, readLedger, writeLive, readJson, writeJson, fingerprint, gitHead } from './ledger.mjs';

const STATE = '.signoff/state';
const statePath = (root) => join(root, STATE, 'gate.json');
const SESSION_TTL = 14 * 24 * 3600 * 1000;

export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) data += c;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

function loadState(root) {
  const state = readJson(statePath(root), null) ?? {};
  state.sessions ??= {};
  state.lastPass ??= null;
  state.lastCheck ??= null;
  for (const [id, s] of Object.entries(state.sessions)) {
    if (s?.at && Date.now() - s.at > SESSION_TTL) delete state.sessions[id];
  }
  return state;
}

const switchedOff = (root) => process.env.SIGNOFF_SKIP === '1' || existsSync(join(root, '.signoff', 'off'));

/**
 * UserPromptSubmit hook: remember what the code looked like when the human asked for something.
 * The gate compares against it, so a turn that changed no code (a question, an explanation)
 * is never held up, and every new request gets a full set of rounds.
 */
export function markPrompt(input = {}) {
  const root = hookRoot(input);
  if (!root || switchedOff(root)) return;
  const state = loadState(root);
  const ss = (state.sessions[input.session_id || 'cli'] ??= { rounds: 0 });
  ss.at = Date.now();
  ss.rounds = 0;
  ss.foreign = 0;
  // Only from a clean start: a message typed while the agent is still working must not
  // move the baseline past changes Kane has not seen yet.
  if (ss.settled !== false) {
    ss.baseFp = fingerprint(root);
    ss.settled = false;
    // Did the specs already differ from the signed ones before the agent touched anything?
    // Then a human edited them and forgot to lock: that must not be blamed on the agent.
    try { ss.lockOk = checkLock(root, loadConfig(root)).ok; } catch { delete ss.lockOk; }
    // Marks where a request starts, so the timeline can show one request's rounds at a time.
    appendLedger(root, { kind: 'prompt', session: input.session_id || 'cli' });
  }
  writeJson(statePath(root), state);
}

/** "3 × read a hidden spec, 1 × change a locked file": what the guard refused in this session. */
function guardSummary(root, session) {
  const labels = { hidden: 'read a hidden spec', locked: 'change a locked file', admin: 'run a human-only Signoff command', kill: 'kill processes by name', search: 'search across the hidden specs' };
  const counts = {};
  for (const e of readLedger(root)) if (e.kind === 'guard' && e.session === session) counts[e.rule] = (counts[e.rule] ?? 0) + 1;
  const parts = Object.entries(counts).map(([rule, n]) => `${n} × ${labels[rule] ?? rule}`);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Run the gate. mode = 'hook' (Claude Code Stop hook protocol on stdout)
 * or 'cli' (human-readable, exit code 0/1).
 */
export async function gate({ mode = 'hook', input = {}, force = false, log = () => {} } = {}) {
  const root = mode === 'hook' ? hookRoot(input) : findRoot(input.cwd || process.cwd());
  const allow = (msg) => ({ decision: 'allow', message: msg });
  if (!root) return allow(null);
  if (switchedOff(root)) return allow('Signoff is switched off for this project (.signoff/off).');

  const session = input.session_id || 'cli';
  const state = loadState(root);
  const save = () => writeJson(statePath(root), state);
  const ss = (state.sessions[session] ??= { rounds: 0 });
  ss.at = Date.now();
  const head = gitHead(root);
  // Claude Code stops a Stop hook after its timeout (30 minutes as installed). Finish before
  // that, so a long suite ends with a clear message instead of a killed hook.
  let deadline = Date.now() + 1620 * 1000;
  let cfg = null, specs = [], fp = null, live = null;
  let note = null; // something the agent or the human must be told, whatever else happens
  const refresh = () => {
    cfg = loadConfig(root);
    specs = listSpecs(root, cfg);
    fp = fingerprint(root);
    if (Number(cfg.gateTimeout) > 0) deadline = Math.min(deadline, Date.now() + Number(cfg.gateTimeout) * 1000);
    live = { phase: 'checking', session, round: ss.rounds + 1, maxRounds: cfg.maxRounds, specs: specs.map((s) => ({ spec: s, status: 'queued', steps: [] })), fp };
  };
  const lockState = () => {
    try { refresh(); return checkLock(root, cfg); }
    catch (err) { return { ok: false, unreadable: err.message, changed: [CONFIG_FILE], added: [], removed: [] }; }
  };

  const decision = await decide();
  // Letting the agent stop ends its turn: the next request starts from this code, with a full set of rounds.
  if (decision.decision !== 'block') {
    const s = (state.sessions[session] ??= { rounds: 0 });
    Object.assign(s, { rounds: 0, foreign: 0, settled: true, baseFp: fp ?? fingerprint(root), at: Date.now() });
    save();
  }
  if (note && decision.decision === 'block') decision.reason = `${note}\n\n${decision.reason}`;
  else if (note) decision.message = [note, decision.message].filter(Boolean).join('\n');
  return decision;

  async function decide() {
    // 1. Spec lock: the definition of done must be the one a human signed.
    let lock = lockState();
    if (!lock.ok && ss.lockOk === true) {
      // They matched when this request started, so they changed during it: put the signed
      // versions back (keeping what was there) instead of sending the agent to "restore" them.
      const keepDir = join(root, '.signoff', 'rounds', `${session.slice(0, 8)}-replaced-${Date.now()}`);
      const restored = [];
      let failed = [];
      // A restored lock or config can reveal more changes (a deleted lock hides a changed spec), so look again.
      for (let pass = 0; pass < 4 && !lock.ok; pass++) {
        const r = restoreLocked(root, lock, keepDir);
        failed = r.failed;
        if (!r.restored.length) break;
        restored.push(...r.restored.filter((f) => !restored.includes(f)));
        lock = lockState();
      }
      appendLedger(root, { kind: 'round', session, round: ss.rounds + 1, status: 'restored', head, files: restored, failed });
      if (restored.length) {
        note = `Signoff: locked files were changed during this turn (${restored.join(', ')}). They are the definition of done and only a human may change them, so Signoff put the signed versions back; what was there is kept in ${relative(root, keepDir).split('\\').join('/')}. Change the application, not the specs.`;
      }
    }
    if (!lock.ok && lock.unreadable) {
      return allow(`Signoff: ${CONFIG_FILE} cannot be read (${lock.unreadable}), so nothing was verified. Fix the file and finish again.`);
    }
    if (!lock.ok && ss.lockOk === false) {
      // They already differed when this request started, so the agent did not do it. Telling
      // the agent to "restore" them could undo a human's edit: say it to the human instead.
      const files = [...lock.changed, ...lock.added, ...lock.removed].join(', ');
      appendLedger(root, { kind: 'round', session, round: ss.rounds + 1, status: 'unlocked_specs', fp, head, lock });
      return allow(`Signoff: the specs differ from the ones that were signed (${files}), and they already did when this request started. Nothing was verified. If you changed them on purpose, sign them again with the \`lock\` command.`);
    }
    if (!lock.ok) {
      ss.rounds += 1;
      save();
      const reason = agentReport(root, { lockProblem: lock });
      appendLedger(root, { kind: 'round', session, round: ss.rounds, status: 'tampered', fp, head, lock });
      writeLive(root, { ...live, phase: 'tampered', round: ss.rounds, lock });
      if (ss.rounds > cfg.maxRounds) return allow(`Signoff: the locked specs were changed and were not put back after ${cfg.maxRounds} rounds. Nothing was signed off.`);
      return { decision: 'block', reason };
    }
    if (!specs.length) return allow(`Signoff: no *_test.md specs in ${cfg.specs}/ yet.`);

    // 2. The agent changed no code in this turn (it answered a question, say): there is
    //    nothing new to sign off, so never hold it up and never spend credits.
    if (!force && ss.baseFp && ss.baseFp === fp) {
      const stillFailing = state.lastCheck?.fp === fp && state.lastCheck.status === 'failed';
      return allow(stillFailing ? 'Signoff: no code changed in this turn, so Kane did not run. This code is still not signed off (Kane\'s last run on it failed).' : null);
    }

    // 3. Nothing changed since Kane last looked: don't spend credits again.
    if (!force && state.lastPass?.fp === fp) {
      return allow(`Kane already signed off on this exact code (${state.lastPass.passed}/${state.lastPass.total} specs, ${state.lastPass.when}).`);
    }
    if (!force && state.lastCheck?.fp === fp && state.lastCheck.status === 'failed' && ss.rounds > 0) {
      if (ss.rounds >= cfg.maxRounds) return allow(`Signoff gave up after ${cfg.maxRounds} rounds; Kane still fails on this code. See .signoff/RECEIPT.md.`);
      ss.rounds += 1;
      save();
      appendLedger(root, { kind: 'round', session, round: ss.rounds, status: 'unchanged', fp, head });
      return { decision: 'block', reason: `Nothing in the code changed since Kane's last failing run, so the same specs still fail (round ${ss.rounds} of ${cfg.maxRounds}).\n\n${state.lastCheck.report}` };
    }
    if (ss.rounds >= cfg.maxRounds) {
      return allow(`Signoff gave up after ${cfg.maxRounds} rounds without a pass. The last report is in .signoff/RECEIPT.md.`);
    }

    ss.rounds += 1;
    const round = ss.rounds;
    live.round = round;
    save();
    appendLedger(root, { kind: 'round_start', session, round, fp, head, specs });
    writeLive(root, { ...live, phase: 'starting app' });

    // 4. Make sure the app is up.
    const server = await ensureServer(root, cfg, log);
    if (server.foreign) {
      // Usually a dev server the agent left running. Ask once, then hand it to the human.
      ss.foreign = (ss.foreign ?? 0) + 1;
      ss.rounds -= 1;
      save();
      appendLedger(root, { kind: 'round', session, round, status: 'port_busy', fp, head, reason: server.reason });
      writeLive(root, { ...live, phase: 'port busy', reason: server.reason });
      if (ss.foreign > 1) return allow(`Signoff: ${server.reason} Stop whatever is using that port and finish again. Nothing was verified.`);
      return { decision: 'block', reason: `${server.reason}

If you started a server on that port, stop it now: Signoff starts the app itself (\`${cfg.start}\`) so Kane always tests this exact code. Then finish again.` };
    }
    if (!server.ok) {
      if (server.started) stopServer(root);
      const reason = agentReport(root, { round, maxRounds: cfg.maxRounds, serverProblem: server });
      state.lastCheck = { fp, status: 'failed', report: reason };
      save();
      appendLedger(root, { kind: 'round', session, round, status: 'app_down', fp, head, reason: server.reason });
      writeLive(root, { ...live, phase: 'app down', reason: server.reason });
      if (!server.appCrashed && !cfg.start) return allow(`Signoff: ${server.reason} Start your app and finish again.`);
      return { decision: 'block', reason };
    }

    // 5. Run every spec with Kane CLI, then always stop the app we started
    //    (also when this process is told to stop: Ctrl+C on `check`, or the hook's timeout).
    const onSignal = () => { try { stopServer(root); } catch { /* best effort */ } setImmediate(() => process.exit(130)); };
    if (server.started) { process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); }
    try {
      return await runRound(round);
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (server.started) stopServer(root);
    }
  }

  async function runRound(round) {
    const results = [];
    const notRun = [];
    const evidence = new Map();
    let credits = 0;
    const roundDir = join(root, '.signoff', 'rounds', `${session.slice(0, 8)}-r${round}`);
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const left = deadline - Date.now();
      if (left < 30_000) { notRun.push(spec); live.specs[i].status = 'not run'; continue; }
      live.specs[i].status = 'running';
      writeLive(root, { ...live, phase: `Kane is testing ${spec}` });
      log(`kane: ${spec}`);
      const since = Date.now();
      if (cfg.cdpEndpoint) { try { await clearOrigin(cfg.cdpEndpoint, cfg.url); } catch (err) { log(`could not clear browser storage: ${err.message}`); } }
      const r = await runSpec(spec, {
        cwd: root, url: cfg.url, headless: cfg.headless, cdpEndpoint: cfg.cdpEndpoint,
        timeoutMs: Math.min(cfg.specTimeout * 1000, left - 15_000),
        onEvent: (e) => {
          const text = e.remark ?? e.one_liner ?? e.summary ?? (e.type === 'test_md_step_start' ? (e.heading ?? e.title) : null);
          if (!text) return;
          live.specs[i].steps.push({ status: e.status ?? (e.type === 'test_md_step_start' ? 'running' : 'info'), text: String(text).slice(0, 200), type: e.type ?? 'step' });
          if (live.specs[i].steps.length > 60) live.specs[i].steps.shift();
          writeLive(root, { ...live, phase: `Kane is testing ${spec}` });
        },
      });
      credits += r.credits;
      if (r.status === 'error') {
        // Kane itself did not run (not installed, not signed in, no Chrome, no network).
        // That is not the agent's fault: never trap it, and never count the round.
        appendLedger(root, { kind: 'round', session, round, status: 'kane_error', spec, stderr: r.stderrTail });
        writeLive(root, { ...live, phase: 'Kane could not start', stderr: r.stderrTail });
        ss.rounds -= 1;
        save();
        return allow(`Signoff: Kane CLI could not run (exit ${r.code}), so nothing was verified.${r.stderrTail ? `\n${r.stderrTail}` : ''}\nIs Kane CLI installed (\`npm install -g @testmuai/kane-cli\`) and signed in? Check \`kane-cli whoami\` and \`kane-cli balance\`.`);
      }
      const pack = newestEvidence(root, since);
      if (r.status !== 'passed' && pack) {
        try { evidence.set(spec, readEvidence(pack, { outDir: roundDir })); } catch (err) { log(`evidence unreadable: ${err.message}`); }
      }
      live.specs[i].status = r.status;
      live.specs[i].duration = r.duration;
      live.specs[i].shareUrl = r.shareUrl;
      results.push(r);
    }

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.length - passed;
    const summaryRows = results.map((r) => ({ spec: r.spec, status: r.status, duration: Math.round(r.duration), credits: r.credits, shareUrl: r.shareUrl }));

    if (!failed && notRun.length) {
      // Out of time with nothing failing: not a sign-off, and not something the agent can fix.
      ss.rounds -= 1;
      save();
      appendLedger(root, { kind: 'round', session, round, status: 'out_of_time', fp, head, results: summaryRows, credits, notRun });
      writeLive(root, { ...live, phase: 'out of time', results: summaryRows });
      return allow(`Signoff ran out of time: ${notRun.length} of ${specs.length} specs were not run, so nothing was signed off. Keep the sign-off suite to a few key flows, or raise the Stop hook timeout in .claude/settings.json.`);
    }

    if (!failed) {
      state.lastPass = { fp, head, passed, total: results.length, when: new Date().toISOString() };
      state.lastCheck = { fp, status: 'passed' };
      const rounds = ss.rounds;
      save();
      const rc = receipt({ root, status: 'passed', rounds, results, fp, head, credits, guard: guardSummary(root, session) });
      writeReceipt(root, rc);
      appendLedger(root, { kind: 'round', session, round, status: 'passed', fp, head, results: summaryRows, credits });
      writeLive(root, { ...live, phase: 'signed off', results: summaryRows });
      return allow(`Kane CLI signed off: ${passed}/${results.length} specs passed in a real browser (round ${round}). Receipt: .signoff/RECEIPT.md`);
    }

    const reason = agentReport(root, { round, maxRounds: cfg.maxRounds, results, evidence, notRun, blind: cfg.blind });
    state.lastCheck = { fp, status: 'failed', report: reason };
    save();
    mkdirSync(roundDir, { recursive: true });
    writeFileSync(join(roundDir, 'report.md'), reason + '\n');
    const roundsBase = join(root, '.signoff', 'rounds');
    const bugs = [];
    for (const [spec, ev] of evidence) for (const t of ev.tests) for (const f of t.failures) {
      bugs.push({ spec, title: f.title, error: f.error, rootCause: f.rootCause, fix: f.fix, severity: f.severity, shots: t.shots.map((p) => p.slice(roundsBase.length + 1).split('\\').join('/')), console: t.console.slice(0, 3), network: t.network.slice(0, 3) });
    }
    appendLedger(root, { kind: 'round', session, round, status: 'failed', fp, head, results: summaryRows, credits, bugs, report: reason });
    writeLive(root, { ...live, phase: round >= cfg.maxRounds ? 'gave up' : 'sent back to the agent', results: summaryRows, bugs, report: reason });

    if (round >= cfg.maxRounds) {
      writeReceipt(root, receipt({ root, status: 'failed', rounds: round, results, fp, head, credits, gaveUp: true, guard: guardSummary(root, session) }));
      return allow(`Signoff gave up after ${round} rounds: Kane still fails ${failed} spec(s). Report: ${join('.signoff', 'rounds', `${session.slice(0, 8)}-r${round}`, 'report.md')}`);
    }
    return { decision: 'block', reason };
  }
}

function writeReceipt(root, text) {
  mkdirSync(join(root, '.signoff', 'receipts'), { recursive: true });
  writeFileSync(join(root, '.signoff', 'RECEIPT.md'), text);
  writeFileSync(join(root, '.signoff', 'receipts', new Date().toISOString().replace(/[:.]/g, '-') + '.md'), text);
}
