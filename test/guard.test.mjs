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

test('reads are allowed by default, including round screenshots', () => {
  assert.equal(run('Read', { file_path: join(root, 'signoff', 'checkout_test.md') }), null);
  assert.equal(run('Read', { file_path: join(root, '.signoff', 'rounds', 'r1', 'shot.jpg') }), null);
});

test('hidden specs: no reading, searching or cat-ing them', () => {
  const blindRoot = mkdtempSync(join(tmpdir(), 'signoff-blind-'));
  writeFileSync(join(blindRoot, 'signoff.config.json'), JSON.stringify({ url: 'http://localhost:3000', blind: true }));
  const b = (tool_name, tool_input) => guard({ cwd: blindRoot, tool_name, tool_input });
  assert.ok(denied(b('Read', { file_path: join(blindRoot, 'signoff', 'items_test.md') })));
  assert.ok(denied(b('Grep', { pattern: 'Asha', path: join(blindRoot, 'signoff') })));
  assert.ok(denied(b('Grep', { pattern: 'Asha' })));
  assert.ok(denied(b('Glob', { pattern: '**/*_test.md' })));
  assert.ok(denied(b('Bash', { command: 'cat signoff/items_test.md' })));
  assert.ok(denied(b('Bash', { command: 'grep -r Asha .' })));
  assert.equal(b('Read', { file_path: join(blindRoot, 'BRIEF.md') }), null);
  assert.equal(b('Read', { file_path: join(blindRoot, '.signoff', 'rounds', 'r1', 'shot.jpg') }), null);
  assert.equal(b('Grep', { pattern: 'total', path: join(blindRoot, 'public') }), null);
  assert.equal(b('Bash', { command: 'grep -r total public' }), null);
});

test('blocks killing processes by name, allows stopping one PID', () => {
  for (const command of [
    '(pkill -f "node server.js" 2>/dev/null || taskkill //F //IM node.exe >/dev/null 2>&1)',
    'taskkill /F /IM node.exe',
    'killall node',
    'Stop-Process -Name node -Force',
    'Get-Process node | Stop-Process -Force',
    'kill -9 -1',
    'kill $(pgrep -f server.js)',
    'wmic process where name="node.exe" delete',
  ]) assert.ok(denied(run('Bash', { command })), command);
  assert.equal(run('Bash', { command: 'kill 4312' }), null);
  assert.equal(run('Bash', { command: 'taskkill /PID 4312 /F' }), null);
  assert.equal(run('PowerShell', { command: 'Stop-Process -Id 4312' }), null);
});

test('a redirect is a write only to the file it points at', () => {
  assert.equal(run('Bash', { command: 'ls -la public signoff .signoff 2>/dev/null && cat package.json signoff.config.json 2>&1' }), null);
  assert.equal(run('Bash', { command: 'node server.js > server.log 2>&1 &' }), null);
  assert.ok(denied(run('Bash', { command: 'echo {} > signoff.config.json' })));
  assert.ok(denied(run('Bash', { command: 'node -e "x" >> .signoff/state/gate.json' })));
  assert.ok(denied(run('Bash', { command: 'printf "x" > "signoff/a_test.md"' })));
});
