// PreToolUse hook.
//  1. Locked specs: the agent may not change the specs that define "done",
//     the gate's config, or the gate's own state (file tools and obvious shell routes).
//  2. Hidden specs (config "blind": true): the agent may not read the specs either.
//     It works from the brief and learns only from Kane's failures, like a hold-out set.
//  3. No mass kills: commands that kill processes by name would take down Kane CLI,
//     its browser and the app under test (and other programs); a single PID is fine.
import { isAbsolute, relative, resolve } from 'node:path';
import { findRoot, loadConfig, isProtected } from './config.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);
const WRITE_SHELL = /(>>?|\btee\b|\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bdd\b|Set-Content|Out-File|Add-Content|Remove-Item|Move-Item|Copy-Item|\bgit\s+(checkout|restore|rm|mv|stash)\b|writeFileSync|fs\.write|open\([^)]*['"]w)/i;

// taskkill /IM, pkill, killall, Stop-Process -Name, Get-Process <name> | Stop-Process, kill -1, wmic ... delete
const MASS_KILL = /\btaskkill\b[^|;&]*\s[/-]im\b|\bpkill\b|\bkillall\b|\bStop-Process\b[^|;&]*-(Name|ProcessName)\b|\bGet-Process\b[^|;]*\|\s*Stop-Process\b|\bkill\s+(-\w+\s+)*-1\b|\bwmic\b[^|;&]*\bprocess\b[^|;&]*\bdelete\b|\bkill\s+[^|;&]*\$\(\s*pgrep\b/i;

const pathRegex = (stem) => {
  const esc = stem.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]');
  // match as a path, not inside another name (".signoff/x" is not "signoff/x")
  return new RegExp(`(^|[\\s'"=(:,])(\\.[\\\\/])?${esc}`);
};

export function guard(input) {
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return null;
  const cfg = loadConfig(root);
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const specDir = cfg.specs + '/';

  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Signoff: ${reason}` } });
  const locked = (what) => deny(`${what} is locked. The Kane specs are the definition of done and only a human may change them. Change the application so it passes the specs instead.`);
  const hidden = () => deny(`the Kane specs in ${specDir} are hidden in this project. Build from the brief; when you finish, Kane runs the specs in a real browser and tells you exactly what failed.`);

  const rel = (p) => { const abs = isAbsolute(p) ? p : resolve(input.cwd || root, p); return relative(root, abs).split('\\').join('/'); };
  const inSpecs = (r) => r === cfg.specs || r.startsWith(specDir) || /_test\.md$/i.test(r);

  const paths = [ti.file_path, ti.notebook_path, ti.path, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.file_path) : [])].filter(Boolean);

  if (WRITE_TOOLS.has(tool)) {
    for (const p of paths) { const r = rel(p); if (!r.startsWith('..') && isProtected(r, cfg)) return locked(`\`${r}\``); }
    return null;
  }

  if (READ_TOOLS.has(tool)) {
    if (!cfg.blind) return null;
    for (const p of paths) { const r = rel(p); if (!r.startsWith('..') && inSpecs(r)) return hidden(); }
    const pattern = `${ti.pattern ?? ''} ${ti.glob ?? ''}`;
    if (/_test\.md/i.test(pattern) || pathRegex(specDir).test(pattern)) return hidden();
    // A repo-wide search would sweep the specs in too: steer it away from them.
    if ((tool === 'Grep' || tool === 'Glob') && !ti.glob && (!ti.path || rel(ti.path) === '')) {
      if (tool === 'Grep') return deny(`searches must skip ${specDir} because the Kane specs are hidden. Pass a path (for example "public") or a glob.`);
    }
    return null;
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command ?? '');
    // Killing processes by NAME takes Kane CLI, its browser and the app under test down with it
    // (and anything else on the machine). Stopping one process by its PID is still allowed.
    if (MASS_KILL.test(cmd)) {
      return deny('that command kills every process with a given name, which would also kill Kane CLI, its browser and the app Signoff is testing (and other programs on this machine). Stop only a process you started, by its PID (for example `kill <pid>` or `taskkill /PID <pid>`).');
    }
    const mentionsSpecs = /_test\.md/i.test(cmd) || pathRegex(specDir).test(cmd);
    if (cfg.blind && mentionsSpecs) return hidden();
    // A recursive search over the whole project (".", "./", "*" or no path for rg) would read the specs.
    const search = cmd.match(/\b(grep|rg|findstr|Select-String|ag|ack)\b[^|;&]*/)?.[0] ?? '';
    const wholeTree = /\s(\.\/?|\*|\.\\)(\s|$)/.test(search + ' ') || (/^rg\b/.test(search) && !/\s[\w./\\-]+\/?\s*$/.test(search.replace(/^rg\s+(-\S+\s+)*\S+/, '')));
    if (cfg.blind && search && /\s(-\w*[rR]\w*|--recursive)\b|^rg\b/.test(search) && wholeTree && !/--exclude-dir[= ]?\S*signoff|-g\s*['"]?!/.test(search)) {
      return deny(`recursive searches must exclude ${specDir} because the Kane specs are hidden (for example add --exclude-dir=${cfg.specs}).`);
    }
    if (!WRITE_SHELL.test(cmd)) return null;
    if (mentionsSpecs) return locked('Spec files (*_test.md)');
    for (const g of cfg.protect) {
      const stem = g.split('*')[0];
      if (stem && pathRegex(stem).test(cmd)) return locked(`\`${g}\``);
    }
  }
  return null;
}

