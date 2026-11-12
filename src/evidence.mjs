// Turns a sealed Kane CLI evidence pack into a short, token-cheap diagnosis a
// coding agent can act on: what failed, Kane's root-cause triage, the console
// errors and failed requests at that step, and the screenshot Kane saw.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openZip } from './zip.mjs';
import { parseYaml } from './yaml.mjs';

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + ' …' : s; };

function ndjson(text) {
  if (!text) return [];
  return text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function consoleProblems(text, step) {
  return ndjson(text)
    .filter((e) => e.text && /error|warn|assert/i.test(e.level ?? '') && (!step || !e.step || e.step === step))
    .filter((e) => !/favicon\.ico/i.test(e.url ?? '') && !/favicon\.ico/i.test(e.text))
    .map((e) => ({ level: e.level, msg: clip(e.text, 220), url: e.url ?? null, step: e.step ?? null }));
}

function networkProblems(text, step) {
  let har;
  try { har = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const e of har?.log?.entries ?? []) {
    const status = e.response?.status ?? 0;
    if (!(status >= 400 || status === 0)) continue;
    const s = e._step ?? e.step ?? e._kane?.step ?? null;
    if (step && s && s !== step) continue;
    const url = e.request?.url ?? '';
    if (/favicon\.ico|google-analytics|googletagmanager|doubleclick|hotjar|sentry\.io/.test(url)) continue;
    out.push({ method: e.request?.method ?? 'GET', url: clip(url, 160), status: status || 'failed', body: clip(e.response?.content?.text ?? '', 180) });
  }
  return out;
}

const dedupe = (list, key) => { const seen = new Set(); return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

/**
 * Read an evidence pack. With outDir, the failing step's screenshots are
 * written there so the agent can open the image Kane saw.
 */
export function readEvidence(packPath, { outDir } = {}) {
  const zip = openZip(packPath);
  const names = zip.names();
  const tests = [...new Set(names.filter((n) => n.startsWith('tests/')).map((n) => n.split('/')[1]))];
  const out = { pack: packPath, tests: [] };

  for (const t of tests) {
    const base = `tests/${t}/`;
    const result = parseYaml(zip.text(base + 'result.yaml')) ?? {};
    const test = { id: t, status: result.status ?? null, failures: [], console: [], network: [], shots: [] };
    const stepDirs = [...new Set(names.filter((n) => n.startsWith(base + 'steps/')).map((n) => n.split('/')[3]))]
      .sort((a, b) => parseInt(a) - parseInt(b));

    for (const d of stepDirs) {
      const fy = parseYaml(zip.text(`${base}steps/${d}/failure.yaml`));
      if (!fy) continue;
      const tri = fy.triage ?? {};
      const f = {
        dir: d,
        step: fy.step ?? null,
        error: fy.error?.message ?? (typeof fy.error === 'string' ? fy.error : null),
        title: fy.title ?? null,
        url: fy.page_state?.url ?? null,
        rootCause: tri.rca?.root_cause ?? null,
        category: tri.rca?.category ?? null,
        confidence: tri.rca?.confidence ?? null,
        severity: tri.severity ?? null,
        fix: tri.suggested_fix?.summary ?? null,
      };
      test.failures.push(f);
      for (const n of names.filter((n) => n.startsWith(base + 'logs/'))) {
        if (n.endsWith('-console.ndjson')) test.console.push(...consoleProblems(zip.text(n), f.step));
        if (n.endsWith('-network.har')) test.network.push(...networkProblems(zip.text(n), f.step));
      }
      if (outDir) {
        for (const kind of ['annotated.png', 'screenshot.jpg', 'screenshot.png']) {
          const img = zip.read(`${base}steps/${d}/${kind}`);
          if (!img) continue;
          mkdirSync(outDir, { recursive: true });
          const p = join(outDir, `${t}-step${d.split('-')[0]}-${kind}`);
          writeFileSync(p, img);
          test.shots.push(p);
          break; // one image per failing step is enough
        }
      }
    }

    // No per-step failure record (e.g. a timeout): keep the last screenshot for context.
    if (outDir && !test.failures.length && /fail|error/i.test(test.status ?? '') && stepDirs.length) {
      const last = stepDirs[stepDirs.length - 1];
      const img = zip.read(`${base}steps/${last}/screenshot.jpg`) ?? zip.read(`${base}steps/${last}/screenshot.png`);
      if (img) { mkdirSync(outDir, { recursive: true }); const p = join(outDir, `${t}-step${last.split('-')[0]}-last.jpg`); writeFileSync(p, img); test.shots.push(p); }
    }
    test.console = dedupe(test.console, (c) => c.msg).slice(0, 6);
    test.network = dedupe(test.network, (n) => `${n.method} ${n.url} ${n.status}`).slice(0, 6);
    out.tests.push(test);
  }
  return out;
}
