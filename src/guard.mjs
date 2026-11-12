// PreToolUse hook: the agent may not edit the specs that define "done".
// Covers file tools directly and the obvious shell routes (redirects, sed -i, rm, mv, cp, tee).
import { isAbsolute, relative, resolve } from 'node:path';
import { findRoot, loadConfig, isProtected } from './config.mjs';

const WRITE_SHELL = /(>>?|\btee\b|\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bdd\b|Set-Content|Out-File|Add-Content|Remove-Item|Move-Item|Copy-Item|\bgit\s+(checkout|restore|rm|mv)\b|writeFileSync|fs\.write|open\([^)]*['"]w)/i;

export function guard(input) {
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return null;
  const cfg = loadConfig(root);
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};

  const deny = (what) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Signoff: ${what} is locked. The Kane specs are the definition of done and only a human may change them. Change the application so it passes the specs instead.`,
    },
  });

  const paths = [ti.file_path, ti.notebook_path, ti.path, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.file_path) : [])].filter(Boolean);
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(input.cwd || root, p);
    const rel = relative(root, abs).split('\\').join('/');
    if (!rel.startsWith('..') && isProtected(rel, cfg)) return deny(`\`${rel}\``);
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command ?? '');
    if (!WRITE_SHELL.test(cmd)) return null;
    // Does the command mention a protected path? Check each glob's literal stem.
    if (/_test\.md/.test(cmd)) return deny('Spec files (*_test.md)');
    for (const g of cfg.protect) {
      const stem = g.split('*')[0];
      if (!stem) continue;
      // Match the path as a path, not as a substring of another name (".signoff/x" is not "signoff/").
      const esc = stem.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]');
      if (new RegExp(`(^|[\\s'"=(:])(\\.[\\\\/])?${esc}`).test(cmd)) return deny(`\`${g}\``);
    }
  }
  return null;
}
