import test from 'node:test';
import assert from 'node:assert/strict';
import { agentReport } from '../src/report.mjs';

const result = (status) => ({ spec: 'signoff/checkout_test.md', status, events: [], duration: 1 });
const ev = (category) => new Map([['signoff/checkout_test.md', { pack: 'x.evidence', tests: [{ failures: [{ title: 'T', error: 'E', rootCause: 'R', fix: 'F', category }], console: [], network: [], shots: [] }] }]]);

test('a failure blamed on the app reads as a plain bug report', () => {
  const r = agentReport('.', { round: 1, maxRounds: 4, results: [result('failed')], evidence: ev('application_issue/api_error') });
  assert.match(r, /Bug Kane found: T/);
  assert.doesNotMatch(r, /suspects the spec/);
});

test('when Kane blames the test, the agent is pointed at the brief, not told to edit the spec', () => {
  const r = agentReport('.', { round: 1, maxRounds: 4, results: [result('failed')], evidence: ev('automation_bug/state_transition_bug') });
  assert.match(r, /suspects the spec rather than the app/);
  assert.match(r, /check the behaviour against the brief/);
});
