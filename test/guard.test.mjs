import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guard } from '../src/guard.mjs';

const root = mkdtempSync(join(tmpdir(), 'signoff-guard-'));
writeFileSync(join(root, 'signoff.config.json'), JSON.stringify({ url: 'http://localhost:3000' }));
const run = (tool_name, tool_input) => guard({ cwd: root, tool_name, tool_input });
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('blocks editing a spec', () => {
  assert.ok(denied(run('Edit', { file_path: join(root, 'signoff', 'checkout_test.md') })));
  assert.ok(denied(run('Write', { file_path: join(root, 'signoff', 'new_test.md') })));
});
test('blocks editing the gate config and its state', () => {
  assert.ok(denied(run('Write', { file_path: join(root, 'signoff.config.json') })));
  assert.ok(denied(run('Write', { file_path: join(root, '.signoff', 'off') })));
  assert.ok(denied(run('Edit', { file_path: join(root, '.signoff', 'state', 'gate.json') })));
  assert.ok(denied(run('Edit', { file_path: join(root, '.claude', 'settings.json') })));
});
test('allows editing application code', () => {
  assert.equal(run('Edit', { file_path: join(root, 'src', 'app.js') }), null);
  assert.equal(run('Write', { file_path: join(root, 'public', 'index.html') }), null);
});
test('blocks shell writes to specs, allows reads and unrelated commands', () => {
  assert.ok(denied(run('Bash', { command: "sed -i 's/12.00/10.00/' signoff/checkout_test.md" })));
  assert.ok(denied(run('Bash', { command: 'echo x > signoff/a_test.md' })));
  assert.ok(denied(run('Bash', { command: 'rm -rf .signoff/state' })));
  assert.ok(denied(run('Bash', { command: 'git checkout -- signoff/' })));
  assert.equal(run('Bash', { command: 'cat signoff/checkout_test.md' }), null);
  assert.equal(run('Bash', { command: 'npm test > out.txt' }), null);
  assert.equal(run('Bash', { command: 'node bin/kane-signoff.mjs status' }), null);
});
