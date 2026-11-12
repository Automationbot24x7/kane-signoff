// The Stop hook. When the coding agent tries to finish, run the Kane specs.
// Pass: let it finish and write a receipt. Fail: block, and hand the agent
// a diagnosis built from Kane's own evidence so it can fix and try again.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadConfig, listSpecs } from './config.mjs';
import { checkLock } from './lock.mjs';
import { ensureServer } from './server.mjs';
import { runSpec, newestEvidence } from './kane.mjs';
import { readEvidence } from './evidence.mjs';
import { agentReport, receipt } from './report.mjs';
import { appendLedger, writeLive, readJson, writeJson, fingerprint, gitHead } from './ledger.mjs';

const STATE = '.signoff/state';

export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) data += c;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

/**
 * Run the gate. mode = 'hook' (Claude Code Stop hook protocol on stdout)
 * or 'cli' (human-readable, exit code 0/1).
 */
export async function gate({ mode = 'hook', input = {}, force = false, log = () => {} } = {}) {
  const root = findRoot(input.cwd || process.cwd());
  const allow = (msg) => ({ decision: 'allow', message: msg });
  if (!root) return allow(null);
  if (process.env.SIGNOFF_SKIP === '1' || existsSync(join(root, '.signoff', 'off'))) return allow('Signoff is switched off for this project (.signoff/off).');

  const cfg = loadConfig(root);
  const specs = listSpecs(root, cfg);
  if (!specs.length) return allow(`Signoff: no *_test.md specs in ${cfg.specs}/ yet.`);

  const session = input.session_id || 'cli';
  const statePath = join(root, STATE, 'gate.json');
  const state = readJson(statePath, { sessions: {}, lastPass: null, lastCheck: null });
  const ss = (state.sessions[session] ??= { rounds: 0 });
  const fp = fingerprint(root);
  const head = gitHead(root);
  const live = { phase: 'checking', session, round: ss.rounds + 1, maxRounds: cfg.maxRounds, specs: specs.map((s) => ({ spec: s, status: 'queued', steps: [] })), fp };

  // 1. Spec lock: the definition of done must be the one a human signed.
  const lock = checkLock(root, cfg);
  if (!lock.ok) {
    ss.rounds += 1;
    writeJson(statePath, state);
    const reason = agentReport(root, { lockProblem: lock });
    appendLedger(root, { kind: 'round', session, round: ss.rounds, status: 'tampered', fp, head, lock });
    writeLive(root, { ...live, phase: 'tampered', round: ss.rounds, lock });
    if (ss.rounds > cfg.maxRounds) return allow(`Signoff: the locked specs were changed and the agent did not restore them after ${cfg.maxRounds} rounds. Nothing was signed off.`);
    return { decision: 'block', reason };
  }

  // 2. Nothing changed since Kane last looked: don't spend credits again.
  if (!force && state.lastPass?.fp === fp) {
    return allow(`Kane already signed off on this exact code (${state.lastPass.passed}/${state.lastPass.total} specs, ${state.lastPass.when}).`);
  }
  if (!force && state.lastCheck?.fp === fp && state.lastCheck.status === 'failed' && ss.rounds > 0) {
    if (ss.rounds >= cfg.maxRounds) return allow(`Signoff gave up after ${cfg.maxRounds} rounds; Kane still fails on this code. See .signoff/RECEIPT.md.`);
    ss.rounds += 1;
    writeJson(statePath, state);
    appendLedger(root, { kind: 'round', session, round: ss.rounds, status: 'unchanged', fp, head });
    return { decision: 'block', reason: `Nothing in the code changed since Kane's last failing run, so the same specs still fail (round ${ss.rounds} of ${cfg.maxRounds}).\n\n${state.lastCheck.report}` };
  }
  if (ss.rounds >= cfg.maxRounds) {
    return allow(`Signoff gave up after ${cfg.maxRounds} rounds without a pass. The last report is in .signoff/RECEIPT.md.`);
  }

  ss.rounds += 1;
  const round = ss.rounds;
  live.round = round;
  writeJson(statePath, state);
  appendLedger(root, { kind: 'round_start', session, round, fp, head, specs });
  writeLive(root, { ...live, phase: 'starting app' });

  // 3. Make sure the app is up.
  const server = await ensureServer(root, cfg, log);
  if (!server.ok) {
    const reason = agentReport(root, { round, maxRounds: cfg.maxRounds, serverProblem: server });
    state.lastCheck = { fp, status: 'failed', report: reason };
    writeJson(statePath, state);
    appendLedger(root, { kind: 'round', session, round, status: 'app_down', fp, head, reason: server.reason });
    writeLive(root, { ...live, phase: 'app down', reason: server.reason });
    if (!server.appCrashed && !cfg.start) return allow(`Signoff: ${server.reason} Start your app and finish again.`);
    return { decision: 'block', reason };
  }

  // 4. Run every spec with Kane CLI.
  const results = [];
  const evidence = new Map();
  let credits = 0;
  const roundDir = join(root, '.signoff', 'rounds', `${session.slice(0, 8)}-r${round}`);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    live.specs[i].status = 'running';
    writeLive(root, { ...live, phase: `Kane is testing ${spec}` });
    log(`kane: ${spec}`);
    const since = Date.now();
    const r = await runSpec(spec, {
      cwd: root, url: cfg.url, headless: cfg.headless, timeoutMs: cfg.specTimeout * 1000,
      onEvent: (e) => {
        const text = e.remark ?? e.one_liner ?? e.summary ?? (e.type === 'test_md_step_start' ? (e.heading ?? e.title) : null);
        if (!text) return;
        live.specs[i].steps.push({ status: e.status ?? (e.type === 'test_md_step_start' ? 'running' : 'info'), text: String(text).slice(0, 200), type: e.type ?? 'step' });
        if (live.specs[i].steps.length > 60) live.specs[i].steps.shift();
        writeLive(root, { ...live, phase: `Kane is testing ${spec}` });
      },
    });
    credits += r.credits;
    if (r.code === 2) {
      // Kane itself could not start (auth, Chrome, network). Not the agent's fault: never trap it.
      appendLedger(root, { kind: 'round', session, round, status: 'kane_error', spec, stderr: r.stderrTail });
      writeLive(root, { ...live, phase: 'Kane could not start', stderr: r.stderrTail });
      ss.rounds -= 1; writeJson(statePath, state);
      return allow(`Signoff: Kane CLI could not start (exit 2), so nothing was verified.\n${r.stderrTail}\nCheck \`kane-cli whoami\` and \`kane-cli balance\`.`);
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
  const ok = passed === results.length;
  const summaryRows = results.map((r) => ({ spec: r.spec, status: r.status, duration: Math.round(r.duration), credits: r.credits, shareUrl: r.shareUrl }));

  if (ok) {
    state.lastPass = { fp, head, passed, total: results.length, when: new Date().toISOString() };
    state.lastCheck = { fp, status: 'passed' };
    const rounds = ss.rounds;
    delete state.sessions[session];
    writeJson(statePath, state);
    const rc = receipt({ root, status: 'passed', rounds, results, fp, head, credits });
    writeReceipt(root, rc);
    appendLedger(root, { kind: 'round', session, round, status: 'passed', fp, head, results: summaryRows, credits });
    writeLive(root, { ...live, phase: 'signed off', results: summaryRows });
    return allow(`Kane CLI signed off: ${passed}/${results.length} specs passed in a real browser (round ${round}). Receipt: .signoff/RECEIPT.md`);
  }

  const reason = agentReport(root, { round, maxRounds: cfg.maxRounds, results, evidence });
  state.lastCheck = { fp, status: 'failed', report: reason };
  writeJson(statePath, state);
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
    writeReceipt(root, receipt({ root, status: 'failed', rounds: round, results, fp, head, credits, gaveUp: true }));
    return allow(`Signoff gave up after ${round} rounds: Kane still fails ${results.length - passed} spec(s). Report: ${join('.signoff', 'rounds', `${session.slice(0, 8)}-r${round}`, 'report.md')}`);
  }
  return { decision: 'block', reason };
}

function writeReceipt(root, text) {
  mkdirSync(join(root, '.signoff', 'receipts'), { recursive: true });
  writeFileSync(join(root, '.signoff', 'RECEIPT.md'), text);
  writeFileSync(join(root, '.signoff', 'receipts', new Date().toISOString().replace(/[:.]/g, '-') + '.md'), text);
}
