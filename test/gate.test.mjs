// The gate, end to end, with a stand-in for Kane CLI (test-support/fake-kane.mjs): a real app
// process is started and stopped, a real evidence pack is read, the real hook protocol is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, markPrompt } from '../src/gate.mjs';
import { writeLock } from '../src/lock.mjs';
import { loadConfig } from '../src/config.mjs';
import { fingerprint } from '../src/ledger.mjs';
import { makeProject, useFakeKane } from '../test-support/project.mjs';

useFakeKane();
const stop = (p, session = 's1', extra = {}) => gate({ mode: 'hook', input: { cwd: p.root, session_id: session, hook_event_name: 'Stop', ...extra } });
const prompt = (p, session = 's1') => markPrompt({ cwd: p.root, session_id: session });
const lock = (p) => writeLock(p.root, loadConfig(p.root));

test('the loop: Kane fails, the agent gets the diagnosis, the fix passes, a receipt is written', async () => {
  const p = await makeProject();
  lock(p);
  prompt(p);
  p.page('TOTAL 120 (agent says done)');

  const r1 = await stop(p);
  assert.equal(r1.decision, 'block');
  assert.match(r1.reason, /Kane CLI did not sign off: 1 of 1 spec failed in a real Chrome browser \(round 1 of 3\)/);
  assert.match(r1.reason, /Bug Kane found: The page does not show TOTAL 108 \(major, confidence 0\.94\)/);
  assert.match(r1.reason, /Kane's root cause: The total is computed without the discount/);
  assert.match(r1.reason, /Kane's suggested fix: Keep the applied discount/);
  assert.match(r1.reason, /\[error\] Uncaught TypeError: discount is undefined/);
  assert.match(r1.reason, /Screenshot of what Kane saw \(open it\): \.signoff\/rounds\/s1-r1\/t1-step1-screenshot\.jpg/);
  assert.ok(p.exists('.signoff/rounds/s1-r1/t1-step1-screenshot.jpg'), 'the screenshot Kane saw is saved for the agent');
  assert.ok(await p.appStopped(), 'the app Signoff started is stopped after the round');
  const failed = p.ledger().find((e) => e.kind === 'round' && e.status === 'failed');
  assert.equal(failed.bugs[0].title, 'The page does not show TOTAL 108');

  // The agent tries to stop again without changing anything: same report, no new Kane run.
  const calls = p.kaneCalls();
  const r2 = await stop(p, 's1', { stop_hook_active: true });
  assert.equal(r2.decision, 'block');
  assert.match(r2.reason, /Nothing in the code changed since Kane's last failing run/);
  assert.equal(p.kaneCalls(), calls);

  // It fixes the app.
  p.page('TOTAL 108');
  const r3 = await stop(p, 's1', { stop_hook_active: true });
  assert.equal(r3.decision, 'allow');
  assert.match(r3.message, /Kane CLI signed off: 1\/1 specs passed in a real browser \(round 3\)/);
  assert.match(p.read('.signoff/RECEIPT.md'), /\*\*Signed off by Kane CLI\.\*\* 1\/1 specs passed in a real Chrome browser after 3 rounds\./);
  assert.match(p.read('.signoff/RECEIPT.md'), /\[open\]\(https:\/\/example\.test\/share\//);
  assert.equal(p.state().lastPass.passed, 1);
  assert.ok(await p.appStopped());
});

test('a turn that changes no code is never held up, and costs nothing', async () => {
  const p = await makeProject(); // the page is wrong: Kane would fail it
  lock(p);
  prompt(p);
  const r = await stop(p);
  assert.equal(r.decision, 'allow');
  assert.equal(r.message, null);
  assert.equal(p.kaneCalls(), 0);

  // Same on the next turn, even without the prompt hook: the baseline is where the last turn ended.
  const again = await stop(p);
  assert.equal(again.decision, 'allow');
  assert.equal(p.kaneCalls(), 0);
});

test('code that Kane already signed off is not run again', async () => {
  const p = await makeProject({ page: 'TOTAL 108' });
  lock(p);
  prompt(p);
  p.page('TOTAL 108 and a new footer');
  assert.match((await stop(p)).message, /signed off: 1\/1/);
  prompt(p);
  p.page('TOTAL 108');                     // the agent changes something…
  p.page('TOTAL 108 and a new footer');    // …and changes it back to what Kane signed
  const calls = p.kaneCalls();
  const r = await stop(p);
  assert.equal(r.decision, 'allow');
  assert.equal(p.kaneCalls(), calls);
});

test('Kane not signed in, or not installed, never traps the agent and never counts a round', async () => {
  for (const [directive, pattern] of [['FAKE: exit2', /Kane CLI could not run \(exit 2\), so nothing was verified[\s\S]*not signed in/], ['FAKE: silent-exit1', /Kane CLI could not run/]]) {
    const p = await makeProject({ spec: directive });
    lock(p);
    prompt(p);
    p.page('changed');
    const r = await stop(p);
    assert.equal(r.decision, 'allow', directive);
    assert.match(r.message, pattern);
    assert.equal(p.ledger().find((e) => e.kind === 'round').status, 'kane_error');
    assert.ok(await p.appStopped());
  }
});

test('the round cap ends the loop, and the next request gets a full set of rounds', async () => {
  const p = await makeProject({ config: { maxRounds: 2 } });
  lock(p);
  prompt(p);
  p.page('TOTAL 119');
  assert.equal((await stop(p)).decision, 'block');
  p.page('TOTAL 118');
  const gaveUp = await stop(p, 's1', { stop_hook_active: true });
  assert.equal(gaveUp.decision, 'allow');
  assert.match(gaveUp.message, /Signoff gave up after 2 rounds: Kane still fails 1 spec/);
  assert.match(p.read('.signoff/RECEIPT.md'), /\*\*Not signed off\.\*\*/);

  // A question afterwards is not blocked, but the human is reminded the code is not signed off.
  prompt(p);
  const question = await stop(p);
  assert.equal(question.decision, 'allow');
  assert.match(question.message, /still not signed off/);

  // A new request that changes code is gated again, from round 1.
  prompt(p);
  p.page('TOTAL 117');
  const next = await stop(p);
  assert.equal(next.decision, 'block');
  assert.match(next.reason, /round 1 of 2/);
});

test('specs changed during a request are put back, and nothing is lost', async () => {
  const p = await makeProject();
  lock(p);
  prompt(p);
  p.spec('EXPECT: TOTAL 120');            // the "fix" is to weaken the test
  writeFileSync(join(p.root, 'signoff', 'extra_test.md'), 'EXPECT: anything\n');
  p.page('TOTAL 120 (agent says done)');

  const r = await stop(p);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /^Signoff: locked files were changed during this turn \(signoff\/total_test\.md, signoff\/extra_test\.md\)/);
  assert.match(r.reason, /Kane CLI did not sign off/);
  assert.match(p.read('signoff/total_test.md'), /EXPECT: TOTAL 108/);
  assert.equal(p.exists('signoff/extra_test.md'), false);
  const kept = p.ledger().find((e) => e.status === 'restored');
  assert.deepEqual(kept.files, ['signoff/total_test.md', 'signoff/extra_test.md']);
  const keepDir = r.reason.match(/kept in (\S+?)\. /)[1];
  assert.match(p.read(`${keepDir}/signoff/total_test.md`), /EXPECT: TOTAL 120/);
});

test('a deleted lock, a changed config and a corrupted config are put back too', async () => {
  const p = await makeProject({ page: 'TOTAL 108' });
  lock(p);
  prompt(p);
  rmSync(join(p.root, '.signoff', 'spec-lock.json'));
  const cfg = JSON.parse(p.read('signoff.config.json'));
  writeFileSync(join(p.root, 'signoff.config.json'), JSON.stringify({ ...cfg, specs: 'nowhere' }));
  p.page('TOTAL 108 with a change');
  const r = await stop(p);
  assert.equal(r.decision, 'allow');
  assert.match(r.message, /locked files were changed during this turn/);
  assert.match(r.message, /signed off: 1\/1/);
  assert.equal(JSON.parse(p.read('signoff.config.json')).specs, 'signoff');
  assert.ok(p.exists('.signoff/spec-lock.json'));

  prompt(p);
  writeFileSync(join(p.root, 'signoff.config.json'), '{ not json');
  p.page('TOTAL 108 with another change');
  const r2 = await stop(p);
  assert.match(r2.message, /locked files were changed during this turn \(signoff\.config\.json\)/);
  assert.match(r2.message, /signed off: 1\/1/);
});

test('specs a human edited before the request are not blamed on the agent, and are left alone', async () => {
  const p = await makeProject();
  lock(p);
  p.spec('EXPECT: TOTAL 110');   // the human changes the spec and forgets to lock it again
  prompt(p);
  p.page('TOTAL 110');
  const r = await stop(p);
  assert.equal(r.decision, 'allow');
  assert.match(r.message, /the specs differ from the ones that were signed \(signoff\/total_test\.md\), and they already did when this request started/);
  assert.match(p.read('signoff/total_test.md'), /EXPECT: TOTAL 110/);
  assert.equal(p.kaneCalls(), 0);
});

test('without the prompt hook, changed specs still block the agent', async () => {
  const p = await makeProject();
  lock(p);
  p.spec('EXPECT: TOTAL 120');
  const r = await stop(p);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /Signoff refused: the locked Kane specs were changed\.\n {2}changed: signoff\/total_test\.md/);
});

test('refuses to test a server it did not start', async () => {
  const p = await makeProject();
  lock(p);
  prompt(p);
  p.page('TOTAL 108');
  const other = await new Promise((r) => { const s = http.createServer((q, a) => a.end('stale build')).listen(p.port, () => r(s)); });
  try {
    const r1 = await stop(p);
    assert.equal(r1.decision, 'block');
    assert.match(r1.reason, /Something else is already answering at http:\/\/localhost:\d+/);
    const r2 = await stop(p, 's1', { stop_hook_active: true });
    assert.equal(r2.decision, 'allow');
    assert.match(r2.message, /Nothing was verified/);
    assert.equal(p.kaneCalls(), 0);
  } finally { other.close(); }
});

test('an app that does not start is reported with its log', async () => {
  const p = await makeProject({ config: { start: 'node missing-server.js', readyTimeout: 3 } });
  lock(p);
  prompt(p);
  p.page('changed');
  const r = await stop(p);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /Signoff could not open the app \(round 1 of 3\)/);
  assert.match(r.reason, /Cannot find module/);
});

test('a spec that hangs is stopped at its timeout and reported', async () => {
  const p = await makeProject({ spec: 'FAKE: hang', config: { specTimeout: 3 } });
  lock(p);
  prompt(p);
  p.page('changed');
  const started = Date.now();
  const r = await stop(p);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /The spec timed out/);
  assert.ok(Date.now() - started < 25_000, 'the hung Kane process was stopped');
  assert.ok(await p.appStopped());
});

test('when the gate runs out of time, it says so instead of being killed', async () => {
  const p = await makeProject({ page: 'TOTAL 108', config: { gateTimeout: 1 } });
  lock(p);
  prompt(p);
  p.page('TOTAL 108 changed');
  const r = await stop(p);
  assert.equal(r.decision, 'allow');
  assert.match(r.message, /Signoff ran out of time: 1 of 1 specs were not run, so nothing was signed off/);
});

test('`check` runs the specs even when nothing changed, and reports like the hook', async () => {
  const p = await makeProject();
  lock(p);
  const r = await gate({ mode: 'cli', input: { cwd: p.root, session_id: 'manual' }, force: true });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /Kane CLI did not sign off/);
  assert.equal(p.kaneCalls(), 1);
});

test('the gate is found from CLAUDE_PROJECT_DIR when the agent\'s shell has moved elsewhere', async () => {
  const p = await makeProject();
  lock(p);
  process.env.CLAUDE_PROJECT_DIR = p.root;
  try {
    markPrompt({ cwd: process.cwd(), session_id: 's1' });
    p.page('TOTAL 120 changed');
    const r = await gate({ mode: 'hook', input: { cwd: process.cwd(), session_id: 's1' } });
    assert.equal(r.decision, 'block');
  } finally { delete process.env.CLAUDE_PROJECT_DIR; }
});

test('the code fingerprint follows the code in a project that is not a git repository', async () => {
  const p = await makeProject();
  const a = fingerprint(p.root);
  assert.equal(fingerprint(p.root), a);
  p.page('something else');
  const b = fingerprint(p.root);
  assert.notEqual(b, a);
  writeFileSync(join(p.root, 'public', 'new-file.js'), '1');
  assert.notEqual(fingerprint(p.root), b);
});
