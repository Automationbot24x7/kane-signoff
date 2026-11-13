// Builds the message the coding agent reads when Kane refuses to sign off,
// and the receipt a human reads when it does.
import { relative } from 'node:path';

const rel = (root, p) => relative(root, p).split('\\').join('/');

/** Collect what Kane itself said about failing steps from the NDJSON stream. */
export function failingSteps(events) {
  const out = [];
  let currentHeading = null;
  for (const e of events) {
    if (e.type === 'test_md_step_start') currentHeading = e.heading ?? e.title ?? e.name ?? e.step_name ?? currentHeading;
    const failed = e.status === 'failed' || e.status === 'error' || e.success === false;
    if (!failed) continue;
    if (e.type === 'test_md_done' || e.type === 'stream_start') continue;
    const text = e.remark ?? e.reason ?? e.summary ?? e.one_liner ?? e.message ?? null;
    if (!text) continue;
    out.push({ heading: e.heading ?? e.title ?? e.step_name ?? currentHeading, text: String(text).replace(/\s+/g, ' ').slice(0, 400), type: e.type ?? 'step' });
  }
  // keep the most specific lines, drop duplicates
  const seen = new Set();
  return out.filter((x) => { const k = x.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(-4);
}

export function agentReport(root, { round, maxRounds, results, evidence, lockProblem, serverProblem, blind, notRun = [] }) {
  const L = [];
  if (lockProblem) {
    L.push(lockProblem.deletedLock ? 'Signoff refused: the spec lock (.signoff/spec-lock.json) was deleted.' : 'Signoff refused: the locked Kane specs were changed.');
    for (const f of lockProblem.changed) L.push(`  changed: ${f}`);
    for (const f of lockProblem.added) L.push(`  added:   ${f}`);
    for (const f of lockProblem.removed) L.push(`  removed: ${f}`);
    L.push('');
    L.push('The specs are the definition of done and only a human may change them. Put these files back exactly as they were (`git checkout -- <file>` restores a committed file; delete a file you added), then make the APP pass the specs. Kane will re-check when you stop. If you did not change them, stop and tell the human: they need to run the `lock` command again.');
    return L.join('\n');
  }
  if (serverProblem) {
    L.push(`Signoff could not open the app (round ${round} of ${maxRounds}): ${serverProblem.reason}`);
    if (serverProblem.log) { L.push('', 'Last lines of the app log (.signoff/server.log):', '```', serverProblem.log.trim(), '```'); }
    L.push('', 'Fix whatever stops the app from starting, then stop again. Kane will re-check.');
    return L.join('\n');
  }

  const failed = results.filter((r) => r.status !== 'passed');
  L.push(`Kane CLI did not sign off: ${failed.length} of ${results.length} spec${results.length === 1 ? '' : 's'} failed in a real Chrome browser (round ${round} of ${maxRounds}).`);
  for (const r of results) {
    if (r.status === 'passed') { L.push(``, `PASS  ${r.spec}`); continue; }
    L.push('', `FAIL  ${r.spec}`);
    for (const s of failingSteps(r.events)) L.push(`  Kane: ${s.heading ? `[${s.heading}] ` : ''}${s.text}`);
    const ev = evidence.get(r.spec);
    if (ev) {
      for (const t of ev.tests) {
        for (const f of t.failures.slice(0, 2)) {
          if (f.title) L.push(`  Bug Kane found: ${f.title}${f.severity ? ` (${f.severity}${f.confidence ? `, confidence ${f.confidence}` : ''})` : ''}`);
          if (f.error) L.push(`  What Kane saw: ${f.error}`);
          if (f.url) L.push(`  Page: ${f.url}`);
          if (f.rootCause) L.push(`  Kane's root cause: ${f.rootCause}`);
          if (f.fix) L.push(`  Kane's suggested fix: ${f.fix}`);
          if (/^(automation|test)/i.test(f.category ?? '')) {
            // Kane's triage blames the test, not the app. The assertion still failed, and the
            // agent cannot change the spec, so point it at the source of truth instead.
            L.push(`  Note: Kane's triage (${f.category}) suspects the spec rather than the app. The specs are locked and are the definition of done, so check the behaviour against the brief: if the app breaks the brief, fix the app. If you are sure the spec contradicts the brief, finish and explain the conflict to the human instead of working around it.`);
          }
        }
        if (t.console.length) { L.push('  Browser console:'); for (const c of t.console.slice(0, 5)) L.push(`    [${c.level}] ${c.msg}`); }
        if (t.network.length) { L.push('  Failed network calls:'); for (const n of t.network.slice(0, 5)) L.push(`    ${n.method} ${n.url} -> ${n.status}${n.body ? `  ${n.body}` : ''}`); }
        if (t.shots.length) L.push(`  Screenshot of what Kane saw (open it): ${t.shots.map((p) => rel(root, p)).join(' , ')}`);
      }
      L.push(`  Evidence pack: ${rel(root, ev.pack)}`);
    }
    if (r.status === 'timeout') L.push('  The spec timed out. The page may hang or never reach the expected state.');
    if (r.status === 'error' && r.stderrTail) L.push('  Kane output:', ...r.stderrTail.split('\n').slice(-6).map((x) => '    ' + x));
  }
  for (const spec of notRun) L.push('', `NOT RUN  ${spec}  (the gate ran out of time before reaching it)`);
  L.push('');
  L.push(blind
    ? 'Fix the application so it does what these steps describe. The specs themselves are hidden from you on purpose (like a hold-out test set): work from the brief and the findings above. When you have fixed it, finish again and Kane will re-run every spec.'
    : 'Fix the application code so these specs pass. Do not edit the specs in the signoff folder: they are locked, and changing them is rejected. When you have fixed it, finish again and Kane will re-run the specs.');
  return L.join('\n');
}

export function receipt({ root, status, rounds, results, fp, head, startedAt, credits, gaveUp, guard }) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const L = [];
  L.push(`# Signoff receipt`);
  L.push('');
  L.push(status === 'passed'
    ? `**Signed off by Kane CLI.** ${results.length}/${results.length} specs passed in a real Chrome browser after ${rounds} round${rounds === 1 ? '' : 's'}.`
    : `**Not signed off.** ${gaveUp ? `Signoff stopped after ${rounds} rounds.` : ''} ${results.filter((r) => r.status === 'passed').length}/${results.length} specs passed.`);
  L.push('');
  L.push(`| | |`, `|---|---|`);
  L.push(`| When | ${when} |`);
  if (head) L.push(`| Commit | \`${head}\` + working tree \`${fp}\` |`); else L.push(`| Code fingerprint | \`${fp}\` |`);
  L.push(`| Rounds | ${rounds} |`);
  L.push(`| Kane credits | ${Math.round(credits * 10) / 10} |`);
  if (guard) L.push(`| Refused on the way | ${guard} |`);
  L.push('');
  L.push(`| Spec | Result | Time | Test Manager |`, `|---|---|---|---|`);
  for (const r of results) L.push(`| \`${r.spec}\` | ${r.status === 'passed' ? 'PASS' : 'FAIL'} | ${Math.round(r.duration)}s | ${r.shareUrl ? `[open](${r.shareUrl})` : '-'} |`);
  L.push('');
  L.push(`Round-by-round history: \`.signoff/ledger.ndjson\` (watch it with \`npm run signoff view\`, or \`node .signoff/tool/bin/kane-signoff.mjs view\`).`);
  return L.join('\n') + '\n';
}
