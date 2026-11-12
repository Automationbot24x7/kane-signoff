// `kane-signoff init`: wire Signoff into a project in one command.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DEFAULTS } from './config.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_BIN = '"$CLAUDE_PROJECT_DIR/.signoff/tool/bin/kane-signoff.mjs"';

function guessApp(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const s = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = s.dev ? 'dev' : s.start ? 'start' : null;
    let port = 3000;
    if (deps.vite || /vite/.test(s.dev ?? '')) port = 5173;
    if (deps.astro) port = 4321;
    const m = (s[script] ?? '').match(/(?:--port|-p|PORT=)\s*=?\s*(\d{2,5})/);
    if (m) port = Number(m[1]);
    return { start: script ? `npm run ${script}` : null, url: `http://localhost:${port}` };
  } catch { return {}; }
}

function mergeHooks(root) {
  const p = join(root, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(p)) { try { settings = JSON.parse(readFileSync(p, 'utf8')); } catch { throw new Error(`${p} is not valid JSON; fix it and run init again.`); } }
  settings.hooks ??= {};
  const strip = (arr) => (arr ?? []).filter((h) => !JSON.stringify(h).includes('.signoff/tool'));
  settings.hooks.Stop = [
    ...strip(settings.hooks.Stop),
    { hooks: [{ type: 'command', command: `node ${HOOK_BIN} gate`, timeout: 1800, statusMessage: 'Kane is testing the app in a real browser…' }] },
  ];
  settings.hooks.PreToolUse = [
    ...strip(settings.hooks.PreToolUse),
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|Bash|PowerShell', hooks: [{ type: 'command', command: `node ${HOOK_BIN} guard`, timeout: 15 }] },
  ];
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  return p;
}

const STARTER_SPEC = (url) => `---
mode: testing
url: ${url}
---

# Smoke

## The home page loads
Open the home page.
Verify the page shows its main heading and no error message is visible.
`;

export function init(root, { url, start, force } = {}) {
  const done = [];
  const guess = guessApp(root);
  const cfgPath = join(root, CONFIG_FILE);
  if (!existsSync(cfgPath) || force) {
    const cfg = {
      url: url ?? guess.url ?? DEFAULTS.url,
      start: start ?? guess.start ?? null,
      specs: DEFAULTS.specs,
      maxRounds: DEFAULTS.maxRounds,
      headless: true,
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    done.push(`wrote ${CONFIG_FILE} (app at ${cfg.url}${cfg.start ? `, started with \`${cfg.start}\`` : ''})`);
  } else done.push(`kept existing ${CONFIG_FILE}`);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

  const specDir = join(root, cfg.specs ?? DEFAULTS.specs);
  if (!existsSync(specDir)) {
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'smoke_test.md'), STARTER_SPEC(cfg.url));
    done.push(`created ${cfg.specs}/smoke_test.md (write your own specs next to it)`);
  }

  // Vendor the tool into the project: zero dependencies, committed with the code,
  // so every teammate and every CI box runs the same gate.
  const tool = join(root, '.signoff', 'tool');
  for (const d of ['bin', 'src', 'viewer']) cpSync(join(PKG_ROOT, d), join(tool, d), { recursive: true });
  writeFileSync(join(tool, 'package.json'), JSON.stringify({ name: 'kane-signoff-vendored', type: 'module', private: true }, null, 2) + '\n');
  done.push('vendored the gate into .signoff/tool/ (no dependencies)');

  done.push(`added the Stop and PreToolUse hooks to ${mergeHooks(root).replace(root, '.')}`);

  // A short way to run the vendored tool: `npm run signoff <command>`.
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      pkg.scripts ??= {};
      if (!pkg.scripts.signoff) {
        pkg.scripts.signoff = 'node .signoff/tool/bin/kane-signoff.mjs';
        const indent = (raw.match(/^[ \t]+(?=")/m) ?? ['  '])[0];
        writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + '\n');
        done.push('added `npm run signoff <command>` to package.json');
      }
    } catch { /* leave an unparseable package.json alone */ }
  }

  const gi = join(root, '.gitignore');
  const lines = ['.signoff/state/', '.signoff/live.json', '.signoff/server.log', '.signoff/rounds/', '.testmuai/evidence/'];
  const have = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const missing = lines.filter((l) => !have.split(/\r?\n/).includes(l));
  if (missing.length) { appendFileSync(gi, (have && !have.endsWith('\n') ? '\n' : '') + '# Signoff run artifacts\n' + missing.join('\n') + '\n'); done.push('updated .gitignore'); }
  return done;
}
