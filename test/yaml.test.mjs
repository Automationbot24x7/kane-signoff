import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../src/yaml.mjs';

const failure = `step: 0-2
status: failed
error:
  message: 'Checkout was clicked, but the cart displays Total: $10.00 rather than
    the required $12.00.'
page_state:
  url: http://localhost:4311/
  screenshot: steps/2-0-2/screenshot.jpg
title: Checkout total request fails with missing tax table
triage:
  status: triaged
  rca:
    root_cause: The checkout total service is missing the tax information it needs,
      so it returns an error instead of providing the cart total.
    confidence: 0.99
    evidence:
    - steps/2-0-2/annotated.png
  severity: major
  suggested_fix:
    summary: Restore or configure the tax table used by the checkout total service.
`;

test('reads a Kane failure record', () => {
  const y = parseYaml(failure);
  assert.equal(y.status, 'failed');
  assert.equal(y.error.message, 'Checkout was clicked, but the cart displays Total: $10.00 rather than the required $12.00.');
  assert.equal(y.page_state.url, 'http://localhost:4311/');
  assert.equal(y.triage.rca.root_cause, 'The checkout total service is missing the tax information it needs, so it returns an error instead of providing the cart total.');
  assert.equal(y.triage.rca.confidence, 0.99);
  assert.deepEqual(y.triage.rca.evidence, ['steps/2-0-2/annotated.png']);
  assert.equal(y.triage.severity, 'major');
});

test('reads lists of maps', () => {
  const y = parseYaml(`failures:\n  - test: cart\n    ordinal: 2\n    title: Broken\n  - test: login\n    ordinal: 1\n`);
  assert.equal(y.failures.length, 2);
  assert.equal(y.failures[0].title, 'Broken');
  assert.equal(y.failures[1].test, 'login');
});
