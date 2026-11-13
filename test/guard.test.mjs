import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guard, segments } from '../src/guard.mjs';

delete process.env.CLAUDE_PROJECT_DIR;

function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'signoff-guard-'));
  writeFileSync(join(root, 'signoff.config.json'), JSON.stringify({ url: 'http://localhost:3000', ...config }));
  mkdirSync(join(root, 'signoff'));
  for (const f of ['checkout_test.md', 'items_test.md', 'split_test.md']) writeFileSync(join(root, 'signoff', f), '# spec\n');
  mkdirSync(join(root, 'public'));
  return root;
}
const root = project({});
const blindRoot = project({ blind: true });
const run = (tool_name, tool_input, cwd = root) => guard({ cwd, tool_name, tool_input });
const b = (tool_name, tool_input, cwd = blindRoot) => guard({ cwd, tool_name, tool_input });
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const rule = (r) => r?._log?.rule ?? null;
const sh = (command) => run('Bash', { command });
const bsh = (command) => b('Bash', { command });

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

test('a shell command that names a locked path is refused unless it only reads', () => {
  for (const command of [
    "sed -i 's/12.00/10.00/' signoff/checkout_test.md",
    'echo x > signoff/a_test.md',
    'rm -rf .signoff/state',
    'rm -rf .signoff',
    'git checkout -- signoff/',
    'touch .signoff/off',
    'cp /tmp/easy.md signoff/checkout_test.md',
    'mv signoff /tmp/elsewhere',
    'chmod 000 .signoff/tool',
    'python -c "import shutil; shutil.rmtree(\'.signoff/state\')"',
    'node -e "require(\'fs\').appendFileSync(\'signoff/split_test.md\',\'x\')"',
    'python3 -c "open(\'signoff/checkout_test.md\',\'w\').write(\'\')"',
    'echo x >> .claude/settings.json',
    'prettier --write "**/*.md"',
    'rm -rf *',
    'rm -rf .',
    'cd .signoff && touch off',
    'cd signoff && rm *',
    'cd public && rm -rf ../signoff',
    'D=signoff; rm $D/checkout_test.md',
    'git clean -fdx',
    'git stash -u',
  ]) assert.equal(rule(sh(command)), 'locked', command);
  for (const command of [
    'Set-Content -Path signoff.config.json -Value "{}"',
    'New-Item .signoff/off',
    'Remove-Item -Recurse -Force .claude',
  ]) assert.equal(rule(run('PowerShell', { command })), 'locked', command);
});

test('reads, unrelated commands and ordinary git stay allowed', () => {
  for (const command of [
    'cat signoff/checkout_test.md',
    'ls -la public signoff .signoff 2>/dev/null && cat package.json signoff.config.json 2>&1',
    'npm test > out.txt',
    'node server.js > server.log 2>&1 &',
    'git status --short && git diff --stat',
    'git add -A && git commit -m "update signoff docs"',
    'git diff -- signoff/',
    'git stash',
    'grep -rn total .',
    'kane-cli testmd run signoff/split_test.md --agent --headless',
    'rm -rf node_modules && rm -f *.log',
    'eslint . && prettier --write public',
    'cp -r public /tmp/backup',
    'head -5 signoff.config.json',
    'curl -s http://localhost:4310 | head -20',
    'cat > notes.md <<\'EOF\'\nThe gate lives in .signoff/ and the specs in signoff/.\nrm -rf signoff would be bad.\nEOF',
    'PORT=4397 node server.js & sleep 1; kill $!',
  ]) assert.equal(sh(command), null, command);
});

test('human-only Signoff commands are refused, however they are started', () => {
  for (const command of [
    'npm run signoff off',
    'npm run -s signoff lock',
    'npm run signoff -- off',
    'yarn signoff off',
    'node .signoff/tool/bin/kane-signoff.mjs off',
    'node ".signoff/tool/bin/kane-signoff.mjs" lock',
    'npx kane-signoff init --force',
    'cd public && npm run signoff on',
    'node -e "require(\'child_process\').execSync(\'npm run signoff off\')"',
  ]) assert.equal(rule(sh(command)), 'admin', command);
  for (const command of ['npm run signoff status', 'npm run signoff check', 'node bin/kane-signoff.mjs status', 'npm run signoff view', 'npm run signoff']) assert.equal(sh(command), null, command);
});

test('reads are allowed by default, including round screenshots', () => {
  assert.equal(run('Read', { file_path: join(root, 'signoff', 'checkout_test.md') }), null);
  assert.equal(run('Read', { file_path: join(root, '.signoff', 'rounds', 'r1', 'shot.jpg') }), null);
  assert.equal(run('Grep', { pattern: 'total' }), null);
});

test('hidden specs: file tools cannot read them or the records that give them away', () => {
  assert.equal(rule(b('Read', { file_path: join(blindRoot, 'signoff', 'items_test.md') })), 'hidden');
  assert.equal(rule(b('Read', { file_path: join(blindRoot, '.signoff', 'live.json') })), 'hidden');
  assert.equal(rule(b('Read', { file_path: join(blindRoot, '.signoff', 'state', 'gate.json') })), 'hidden');
  assert.equal(rule(b('Read', { file_path: join(blindRoot, '.testmuai', 'evidence', 'x.evidence') })), 'hidden');
  assert.equal(rule(b('Grep', { pattern: 'Asha', path: join(blindRoot, 'signoff') })), 'hidden');
  assert.equal(rule(b('Glob', { pattern: '**/*_test.md' })), 'hidden');
  assert.equal(rule(b('Grep', { pattern: 'Asha' })), 'search');
  assert.equal(rule(b('Grep', { pattern: 'Asha', path: blindRoot })), 'search');
  assert.equal(rule(b('Grep', { pattern: 'coupon', glob: '*.md' })), 'search');
  assert.equal(rule(b('Grep', { pattern: 'coupon', glob: '**/*.{js,md}' })), 'search');
  // what the agent is meant to read stays readable
  assert.equal(b('Read', { file_path: join(blindRoot, 'BRIEF.md') }), null);
  assert.equal(b('Read', { file_path: join(blindRoot, '.signoff', 'rounds', 'r1', 'shot.jpg') }), null);
  assert.equal(b('Read', { file_path: join(blindRoot, '.signoff', 'rounds', 'r1', 'report.md') }), null);
  assert.equal(b('Grep', { pattern: 'total', path: join(blindRoot, 'public') }), null);
  assert.equal(b('Grep', { pattern: 'total', glob: '*.js' }), null);
  assert.equal(b('Grep', { pattern: 'total', glob: 'public/**' }), null);
  assert.equal(b('Grep', { pattern: 'total', type: 'js' }), null);
  assert.equal(b('Glob', { pattern: '**/*.js' }), null);
});

test('hidden specs: shell reads, wildcards and cd are refused', () => {
  for (const command of [
    'cat signoff/items_test.md',
    'cd signoff && cat *',
    'cat */*.md',
    'cat s*/*',
    'head -3 signoff/*',
    'cat .signoff/live.json',
    'cat .signoff/state/gate.json',
    'unzip -p .testmuai/evidence/a.evidence',
    'git show HEAD:signoff/items_test.md',
    'git log -p -- signoff/',
    'D=signoff; cat $D/items_test.md',
    'cd public && cat ../signoff/items_test.md',
  ]) assert.ok(['hidden', 'locked'].includes(rule(bsh(command))), command);
  assert.equal(rule(b('PowerShell', { command: 'Get-Content signoff\\items_test.md' })), 'hidden');
});

test('hidden specs: commands that read a whole tree are refused', () => {
  for (const command of [
    'grep -r Asha .',
    'grep -rn coupon',
    'rg coupon',
    'git grep -n coupon',
    'find . -name "*.md" -exec cat {} +',
    'find . -type f | xargs grep coupon',
    'find signoff -type f | xargs cat',
    'cat $(find signoff -name "*.md")',
    'cp -r . /tmp/copy',
    'tar czf /tmp/all.tgz .',
    'git log -p',
    'git show HEAD~1',
    'git diff HEAD~2',
    'cd public && grep -rn coupon ..',
  ]) assert.ok(denied(bsh(command)), command);
  assert.equal(rule(b('PowerShell', { command: 'Get-ChildItem -Recurse -Filter *.md | Get-Content' })), 'search');
});

test('hidden specs: ordinary work is not held up', () => {
  for (const command of [
    'grep -r total public',
    'rg total public',
    'ls -la public signoff .signoff .claude && cat package.json server.js signoff.config.json .gitignore && echo ---- && cat public/* 2>/dev/null',
    'find public signoff .signoff .claude -type f | head -50',
    'find . -name "*.js" | head -20',
    'git status && git diff && git log --oneline -5',
    'git show --stat HEAD',
    'git show HEAD:public/app.js',
    'git diff HEAD -- public',
    'npm run signoff status',
    'cat .signoff/RECEIPT.md && cat .signoff/rounds/abc-r1/report.md',
    'cp -r public /tmp/backup',
    'node --check public/app.js && echo SYNTAX_OK',
    'cat BRIEF.md *.json',
  ]) assert.equal(bsh(command), null, command);
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
  ]) assert.equal(rule(sh(command)), 'kill', command);
  assert.equal(sh('kill 4312'), null);
  assert.equal(sh('taskkill /PID 4312 /F'), null);
  assert.equal(run('PowerShell', { command: 'Stop-Process -Id 4312' }), null);
});

test('a redirect is a write only to the file it points at', () => {
  assert.equal(sh('ls -la public signoff .signoff 2>/dev/null && cat package.json signoff.config.json 2>&1'), null);
  assert.equal(sh('node server.js > server.log 2>&1 &'), null);
  assert.ok(denied(sh('echo {} > signoff.config.json')));
  assert.ok(denied(sh('node -e "x" >> .signoff/state/gate.json')));
  assert.ok(denied(sh('printf "x" > "signoff/a_test.md"')));
});

test('the project is found from CLAUDE_PROJECT_DIR even when the shell has moved elsewhere', () => {
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    assert.equal(rule(guard({ cwd: tmpdir(), tool_name: 'Edit', tool_input: { file_path: join(root, 'signoff', 'checkout_test.md') } })), 'locked');
    assert.equal(rule(guard({ cwd: tmpdir(), tool_name: 'Bash', tool_input: { command: `rm -rf "${join(root, '.signoff')}"` } })), 'locked');
  } finally { delete process.env.CLAUDE_PROJECT_DIR; }
});

test('commands are split on separators outside quotes', () => {
  assert.deepEqual(segments('a && b; c | d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(segments('git commit -m "one; two && three"'), ['git commit -m "one; two && three"']);
  assert.deepEqual(segments('cat x 2>&1'), ['cat x']);
  assert.ok(segments('echo "$(cat signoff/a_test.md)"').includes('cat signoff/a_test.md'));
  assert.deepEqual(segments("cat > notes.md <<'EOF'\nrm -rf signoff\nEOF"), ["cat > notes.md <<'EOF'", 'rm -rf signoff', 'EOF']);
});
