// PreToolUse hook: what the coding agent may not do.
//  1. Locked. It may not change the specs that define "done", the gate's config, the hook
//     settings or Signoff's own files, with a file tool or from the shell. A shell command
//     that touches one of those is refused unless it is a plain read: the guard cannot
//     prove an unknown command does not write.
//  2. Hidden (config "blind": true). It may not read the specs either, or the run records
//     that would give them away. It builds from the brief and learns only from Kane's
//     failures, like a hold-out set.
//  3. Human-only commands. It may not switch the gate off, re-sign the specs or re-run init.
//  4. No kills by name. Those take down Kane CLI, its browser and the app under test
//     (and other programs); stopping a single PID is fine.
// This is a guard rail, not a sandbox: it refuses the direct routes and records every
// refusal in the ledger. The spec lock (a hash check at sign-off time) backs it up.
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_FILE, hookRoot, loadConfig, isProtected, listSpecs } from './config.mjs';

const isWin = process.platform === 'win32';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);

// taskkill /IM, pkill, killall, Stop-Process -Name, Get-Process <name> | Stop-Process, kill -1, wmic ... delete
const MASS_KILL = /\btaskkill\b[^|;&]*\s[/-]im\b|\bpkill\b|\bkillall\b|\bStop-Process\b[^|;&]*-(Name|ProcessName)\b|\bGet-Process\b[^|;]*\|\s*Stop-Process\b|\bkill\s+(-\w+\s+)*-1\b|\bwmic\b[^|;&]*\bprocess\b[^|;&]*\bdelete\b|\bkill\s+[^|;&]*\$\(\s*pgrep\b/i;

// The Signoff command line, however it is started: `npm run signoff x`, `npx kane-signoff x`,
// `node .signoff/tool/bin/kane-signoff.mjs x`.
const SIGNOFF_CLI = /(?:kane-signoff(?:\.mjs)?["']?|\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:-\S+\s+)*signoff\b(?:\s+--(?=\s))?)\s*["']?([a-z-]*)/i;
const HUMAN_ONLY = new Set(['off', 'on', 'lock', 'init']);

// Commands that only read. Anything else that names a locked path is refused.
const READ_VERBS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'wc', 'ls', 'll', 'dir', 'stat', 'file', 'tree', 'du', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr',
  'awk', 'gawk', 'cut', 'sort', 'uniq', 'nl', 'tac', 'rev', 'column', 'diff', 'cmp', 'comm', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'strings', 'xxd', 'od', 'hexdump',
  'type', 'echo', 'printf', 'test', '[', '[[', 'cd', 'chdir', 'pushd', 'popd', 'pwd', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'which', 'where', 'kane-cli',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'select-string', 'sls', 'get-filehash', 'resolve-path', 'set-location', 'sl',
  'push-location', 'pop-location', 'get-location', 'measure-object', 'select-object', 'write-output', 'write-host', 'out-host', 'out-string', 'format-list', 'format-table',
]);
const CD_VERBS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
// Read verbs that show names and sizes, never file contents.
const NAMES_ONLY = new Set(['ls', 'll', 'dir', 'tree', 'find', 'stat', 'du', 'cd', 'chdir', 'pushd', 'popd', 'pwd', 'test', '[', '[[', 'echo', 'printf', 'basename', 'dirname', 'realpath',
  'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'resolve-path', 'set-location', 'sl', 'push-location', 'pop-location', 'get-location']);
// git subcommands that change files in the working tree. (`checkout` and `restore` could put a
// spec back, but they could also throw away a human's uncommitted edit: the gate restores
// the signed version itself instead.)
const GIT_WRITES = new Set(['rm', 'mv', 'clean', 'apply', 'am', 'update-index', 'filter-branch', 'checkout-index', 'read-tree', 'checkout', 'restore', 'stash', 'reset']);
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'unlink', 'shred', 'mv', 'move', 'ren', 'rename', 'remove-item', 'ri', 'move-item', 'mi', 'rename-item', 'rni']);
const WRAPPERS = new Set(['sudo', 'time', 'nohup', 'command', 'exec', 'env', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'builtin', 'call', 'start', '!']);
const BULK_COPY = new Set(['rsync', 'scp', 'tar', 'zip', '7z', '7za', 'robocopy', 'xcopy', 'compress-archive']);
const SEARCHERS = new Set(['rg', 'ag', 'ack']);
const GLOB_CHARS = /[*?[{]/;

const norm = (p) => p.split('\\').join('/');
const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');

const pathRegex = (stem) => {
  const esc = stem.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]');
  // match as a path, not inside another name (".signoff/x" is not "signoff/x")
  return new RegExp(`(^|[\\s'"=(:,])(\\.[\\\\/])?${esc}`);
};

/** Split a shell command into simple commands: on ; | & && || newlines, subshells and command substitution. */
/**
 * The body of a heredoc that `cat` or `tee` writes to a file is data, not commands:
 * drop it before reading the command. (One fed to an interpreter is code, and stays in.)
 */
export function stripHeredocs(cmd) {
  return String(cmd).replace(/((?:^|[;&|\n])\s*(?:cat|tee)\b[^\n]*?)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1 $4');
}

export function segments(cmd) {
  const s = String(cmd).replace(/\d?>&\d|&>>?/g, ' ').replace(/\|&/g, '|');
  const out = [];
  let cur = '';
  let q = null;
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      // command substitution still runs inside double quotes
      if (q === '"' && c === '$' && s[i + 1] === '(') { cur += '"'; push(); i++; q = null; continue; }
      if (q === '"' && c === '`') { cur += '"'; push(); q = null; continue; }
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|') || (c === '$' && s[i + 1] === '(')) { push(); i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '`' || c === '(' || c === ')') { push(); continue; }
    cur += c;
  }
  push();
  return out;
}

/** Words of a simple command, with quotes removed. */
function words(seg) {
  const out = [];
  let cur = '';
  let q = null;
  let quoted = false;
  for (const c of seg) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; quoted = true; continue; }
    if (/\s/.test(c)) { if (cur || quoted) out.push(cur); cur = ''; quoted = false; continue; }
    cur += c;
  }
  if (cur || quoted) out.push(cur);
  return out;
}

function verbOf(seg) {
  const w = words(seg);
  let i = 0;
  while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || WRAPPERS.has(w[i].toLowerCase()))) i++;
  const verb = norm(w[i] ?? '').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  return { verb, args: w.slice(i + 1) };
}

/** Shell glob to a regex: `*` and `?` do not cross "/" and do not match a leading dot. */
function shellGlob(glob) {
  const s = norm(glob).replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const atStart = i === 0 || s[i - 1] === '/';
    if (c === '*' && s[i + 1] === '*') { re += '.*'; i++; if (s[i + 1] === '/') i++; }
    else if (c === '*') re += atStart ? '(?!\\.)[^/]*' : '[^/]*';
    else if (c === '?') re += atStart ? '(?!\\.)[^/]' : '[^/]';
    else if (c === '[' && s.indexOf(']', i + 1) > i) { const j = s.indexOf(']', i + 1); re += `[${s.slice(i + 1, j).replace(/\\/g, '\\\\')}]`; i = j; }
    else if (c === '{' && s.indexOf('}', i) > i) { const j = s.indexOf('}', i); re += `(?:${s.slice(i + 1, j).split(',').map(escapeRe).join('|')})`; i = j; }
    else re += escapeRe(c);
  }
  try { return new RegExp(`^${re}$`, 'i'); } catch { return /$^/; }
}

export function guard(input) {
  const root = hookRoot(input);
  if (!root) return null;
  const cfg = loadConfig(root);
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const blind = !!cfg.blind;
  const specDir = cfg.specs + '/';
  const startDir = input.cwd || root;

  const deny = (rule, what, reason) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Signoff: ${reason}` },
    _log: { rule, tool, what: String(what ?? '').replace(/\s+/g, ' ').slice(0, 200) },
  });
  const WHY = 'The Kane specs are the definition of done and only a human may change them. Change the application so it passes the specs instead.';
  const locked = (what, logWhat = what) => deny('locked', logWhat, `${what} is locked. ${WHY}`);
  const lockedShell = (path, cmd) => deny('locked', cmd, `that command could change \`${path}\`, which is locked. The specs, Signoff's config, the hook settings and Signoff's own files belong to the human. Change the application so it passes the specs instead.${blind && isHidden(path) ? '' : ' (Plain reads such as cat, ls, grep and git diff are fine.)'}`);
  const hidden = (what) => deny('hidden', what, `the Kane specs in ${specDir} are hidden in this project. Build from the brief; when you finish, Kane runs the specs in a real browser and tells you exactly what failed.`);
  const hiddenRecords = (what) => deny('hidden', what, 'Signoff\'s run records would give the hidden specs away, so they are hidden too. Everything you need is in the report Kane gave you and the screenshots under .signoff/rounds/.');
  const search = (what) => deny('search', what, `that would read across the whole project, including the hidden Kane specs in ${specDir}. Name the folder or file instead (for example \`grep -rn total public\`).`);

  // ----- paths -----
  const expand = (p) => {
    let s = String(p).replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, norm(root)).replace(/^(\$\{?PWD\}?|\$\(pwd\))/, '.').replace(/^~(?=$|[\\/])/, norm(homedir()));
    if (isWin) s = s.replace(/^\/(?:mnt\/)?([a-zA-Z])\//, '$1:/'); // Git Bash and WSL spellings of a drive
    return s;
  };
  const relOf = (p, base = startDir) => { const e = expand(p); return norm(relative(root, isAbsolute(e) ? e : resolve(base, e))); };
  const isSpec = (r) => r === cfg.specs || r.startsWith(specDir) || /_test\.md$/i.test(r);
  const isRecord = (r) => r === '.testmuai' || r.startsWith('.testmuai/') || r === '.signoff/live.json' || r === '.signoff/state' || r.startsWith('.signoff/state/');
  const isHidden = (r) => isSpec(r) || isRecord(r);
  // Folders that hold locked files, and the files themselves, for wildcard and "parent folder" checks.
  const lockedDirs = [cfg.specs, '.signoff', '.claude'];
  const concrete = [...lockedDirs, ...listSpecs(root, cfg), CONFIG_FILE, '.signoff/off', '.signoff/spec-lock.json', '.signoff/state', '.signoff/state/gate.json',
    '.signoff/tool', '.signoff/live.json', '.signoff/ledger.ndjson', '.claude/settings.json', '.claude/settings.local.json', ...(blind ? ['.testmuai', '.testmuai/evidence'] : [])];
  const isLocked = (r) => isProtected(r, cfg) || lockedDirs.includes(r) || (blind && isHidden(r));
  /** '' = the project root; '..' = above it or outside it. */
  const holdsLocked = (r) => r === '' || concrete.some((c) => c.startsWith(r + '/'));
  const aboveRoot = (p, base) => { const e = expand(p); const up = norm(relative(isAbsolute(e) ? e : resolve(base, e), root)); return !up.startsWith('..') && !isAbsolute(up); };

  const paths = [ti.file_path, ti.notebook_path, ti.path, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.file_path) : [])].filter(Boolean);

  // ----- file tools -----
  if (WRITE_TOOLS.has(tool)) {
    for (const p of paths) { const r = relOf(p); if (!r.startsWith('..') && isProtected(r, cfg)) return locked(`\`${r}\``); }
    return null;
  }

  if (READ_TOOLS.has(tool)) {
    if (!blind) return null;
    for (const p of paths) {
      const r = relOf(p);
      if (r.startsWith('..')) continue;
      if (isSpec(r)) return hidden(r);
      if (isRecord(r)) return hiddenRecords(r);
    }
    const pattern = `${ti.pattern ?? ''} ${ti.glob ?? ''}`;
    if (/_test\.md/i.test(pattern) || pathRegex(specDir).test(pattern)) return hidden(pattern.trim());
    if (tool === 'Grep') {
      // A search whose scope holds the specs must be narrowed to files that cannot be them.
      const scope = ti.path ? relOf(ti.path) : relOf('.');
      const wide = scope.startsWith('..') ? aboveRoot(ti.path ?? '.', startDir) : holdsLocked(scope);
      if (wide && !narrowed(ti)) return search(`Grep ${ti.pattern ?? ''}`);
    }
    return null;
  }

  if (tool !== 'Bash' && tool !== 'PowerShell') return null;

  // ----- shell -----
  const cmd = String(ti.command ?? '');
  // Killing processes by NAME takes Kane CLI, its browser and the app under test down with it
  // (and anything else on the machine). Stopping one process by its PID is still allowed.
  if (MASS_KILL.test(cmd)) {
    return deny('kill', cmd, 'that command kills every process with a given name, which would also kill Kane CLI, its browser and the app Signoff is testing (and other programs on this machine). Stop only a process you started, by its PID (for example `kill <pid>` or `taskkill /PID <pid>`).');
  }
  const shell = stripHeredocs(cmd);

  // Redirects count as a write to the file they point at ("2>/dev/null" next to a
  // `cat signoff.config.json` is a read, not a write).
  for (const m of shell.matchAll(/\d?>>?\|?\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/g)) {
    const target = m[1].replace(/^["']|["']$/g, '');
    if (/^&\d$|^\/dev\/null$|^nul$|^\$null$/i.test(target)) continue;
    const r = relOf(target);
    if (!r.startsWith('..') && (isProtected(r, cfg) || isSpec(r))) return locked(`\`${r}\``, cmd);
  }

  const stems = [specDir, '.signoff/', CONFIG_FILE, '.claude/settings.json', '.claude/settings.local.json', ...(blind ? ['.testmuai'] : [])].map((s) => ({ stem: s, re: pathRegex(s) }));
  let cwd = startDir; // follows `cd` through the command

  for (const seg of segments(shell)) {
    const cli = seg.match(SIGNOFF_CLI);
    if (cli) {
      const sub = cli[1].toLowerCase();
      if (HUMAN_ONLY.has(sub)) {
        return deny('admin', cmd, `\`signoff ${sub}\` is for the human who owns this project: the agent may not switch the gate off, re-sign the specs or re-install the hooks. If the gate is in the way, finish and say so, and let the human decide.`);
      }
      continue; // status, view, check, help: fine
    }

    const { verb, args } = verbOf(seg);
    if (!verb) continue;
    const flagless = args.filter((a) => a && !a.startsWith('-'));

    // What locked or hidden paths does this command name?
    let direct = null;   // a locked path, a file in one, or a wildcard that expands to one
    let above = false;   // the project root, or a folder that holds locked paths
    for (const a of args) {
      const forms = [a];
      if (a.indexOf('=') > 0) forms.push(a.slice(a.indexOf('=') + 1));         // --file=path
      const rev = a.match(/^[^:\\/]{2,}:(.+)$/); if (rev) forms.push(rev[1]);   // HEAD:path
      for (const f of forms) {
        if (!f || f.startsWith('-')) continue;
        if (GLOB_CHARS.test(f)) {
          const re = shellGlob(expand(f));
          const hit = concrete.find((c) => re.test(norm(relative(cwd, join(root, c)))) || (isAbsolute(expand(f)) && re.test(norm(join(root, c)))));
          if (hit) direct ??= hit;
          continue;
        }
        const r = relOf(f, cwd);
        if (r.startsWith('..')) { if (aboveRoot(f, cwd)) above = true; continue; }
        if (r === '') { above = true; continue; }
        if (isLocked(r)) direct ??= r;
        else if (holdsLocked(r)) above = true;
      }
    }
    // Paths buried in code or odd syntax (`open('signoff/a_test.md','w')`, `$D/x_test.md`).
    if (!direct) {
      const s = stems.find((x) => x.re.test(seg));
      if (s) direct = s.stem.replace(/\/$/, '');
      else if (/_test\.md/i.test(seg)) direct = `${cfg.specs}/*_test.md`;
      else if (blind && /\.signoff[\\/](live\.json|state)\b/.test(seg)) direct = '.signoff/live.json';
    }

    if (CD_VERBS.has(verb) && flagless[0]) cwd = resolve(cwd, expand(flagless[0]));

    const gitSub = verb === 'git' ? (flagless[0] ?? '') : null;

    if (direct) {
      if (!readsOnly(verb, args, gitSub)) return lockedShell(direct, cmd);
      // Hidden means the contents: listing names or stepping into the folder gives nothing away.
      if (blind && isHidden(direct) && !NAMES_ONLY.has(verb)) return isRecord(direct) ? hiddenRecords(cmd) : hidden(cmd);
    }
    if (above && DESTRUCTIVE.has(verb)) return lockedShell('the folder that holds the specs and Signoff\'s files', cmd);
    if (gitSub === 'clean' || (gitSub === 'stash' && args.some((a) => /^(-u|--include-untracked|-a|--all)$/.test(a)))) {
      return lockedShell('Signoff\'s untracked files (.signoff/)', cmd);
    }
    if (!blind) continue;

    // Hidden specs: commands that read a whole tree would sweep them in.
    const scopeOf = (list) => (list.length ? list : ['.']).some((p) => { const r = relOf(p, cwd); return r.startsWith('..') ? aboveRoot(p, cwd) : holdsLocked(r); });
    const hasPatternFlag = args.some((a) => /^(-e|-f|--regexp|--file|--files)\b/.test(a));
    const afterDashes = args.includes('--') ? args.slice(args.indexOf('--') + 1) : null;
    const searchPaths = afterDashes ?? (hasPatternFlag ? flagless : flagless.slice(1));
    const recursiveFlag = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || a === '--dereference-recursive');

    if ((verb === 'grep' || verb === 'egrep' || verb === 'fgrep') && recursiveFlag && scopeOf(searchPaths)) return search(cmd);
    if (SEARCHERS.has(verb) && !args.includes('--files') && scopeOf(searchPaths)) return search(cmd);
    if (verb === 'findstr' && args.some((a) => /^\/s$/i.test(a))) return search(cmd);
    if (verb === 'find') {
      const starts = []; for (const a of args) { if (/^[-(!]/.test(a)) break; starts.push(a); }
      if (scopeOf(starts) && (args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) || /\bxargs\b|\$\(\s*find\b|`\s*find\b/.test(cmd))) return search(cmd);
    }
    if ((verb === 'get-childitem' || verb === 'gci' || verb === 'ls' || verb === 'dir') && args.some((a) => /^-(r|rec|recurse|s)$/i.test(a))
      && scopeOf(flagless.filter((a) => !GLOB_CHARS.test(a))) && /\b(get-content|gc|select-string|sls|cat|type)\b/i.test(cmd)) return search(cmd);
    // Copying or archiving a whole tree takes the specs along (for cp, the last word is the destination).
    const isCopy = (verb === 'cp' || verb === 'copy-item' || verb === 'cpi' || verb === 'copy') && args.some((a) => /^-([a-zA-Z]*[rRa][a-zA-Z]*|recurse|-recursive|-archive)$/i.test(a));
    if (isCopy && flagless.length && scopeOf(flagless.slice(0, Math.max(1, flagless.length - 1)))) return search(cmd);
    if (BULK_COPY.has(verb) && flagless.some((p) => scopeOf([p]))) return search(cmd);
    if (verb === 'git') {
      const rest = flagless.slice(1);
      const safePaths = afterDashes && afterDashes.length && !scopeOf(afterDashes);
      const namesOnly = args.some((a) => /^(--stat|--shortstat|--name-only|--name-status|--no-patch|-s|--summary)$/.test(a));
      if (gitSub === 'grep' && scopeOf(afterDashes ?? rest.slice(1))) return search(cmd);
      if (!safePaths && !namesOnly) {
        if (gitSub === 'show' && !rest.some((a) => /^[^:]+:.+/.test(a))) return search(cmd);
        if ((gitSub === 'log' || gitSub === 'whatchanged' || gitSub === 'reflog') && args.some((a) => /^(-p|-u|--patch|--full-diff)$/.test(a))) return search(cmd);
        if (gitSub === 'diff' && rest.some((a) => /[~^]|\.\.|@\{|^[0-9a-f]{7,40}$/.test(a))) return search(cmd);
        if (gitSub === 'stash' && rest[0] === 'show' && args.some((a) => /^(-p|-u|--patch)$/.test(a))) return search(cmd);
        if (['cat-file', 'archive', 'bundle', 'format-patch'].includes(gitSub)) return search(cmd);
      }
    }
  }
  return null;

  /** Does this Grep's glob or type keep it away from Markdown, JSON and other files that could be specs or records? */
  function narrowed(g) {
    const risky = new Set(['md', 'markdown', 'mdx', 'txt', 'json', 'ndjson', 'yaml', 'yml', 'evidence']);
    if (g.type && !risky.has(String(g.type).toLowerCase())) return true;
    const glob = String(g.glob ?? '');
    if (!glob) return false;
    const first = norm(glob).replace(/^\.\//, '').split('/')[0];
    if (first && !GLOB_CHARS.test(first) && norm(glob).includes('/')) return !holdsLocked(relOf(first)) && !isLocked(relOf(first));
    const exts = glob.match(/^(?:\*\*\/)?\*\.(?:\{([\w,]+)\}|(\w+))$/);
    if (!exts) return false;
    return (exts[1] ?? exts[2]).split(',').every((e) => !risky.has(e.toLowerCase()));
  }
}

/** Is this simple command one that only reads? */
function readsOnly(verb, args, gitSub) {
  if (verb === 'git') return !GIT_WRITES.has(gitSub);
  if (verb === 'sed') return !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
  if (verb === 'find') return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a));
  return READ_VERBS.has(verb);
}
