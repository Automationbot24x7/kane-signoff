#!/usr/bin/env node
// A stand-in for Kane CLI, for tests: same command line, same NDJSON stream, same exit
// codes (0 pass, 1 fail, 2 not started), same evidence pack layout. Instead of driving a
// browser with AI, it fetches the page and looks for the text a spec expects:
//
//   EXPECT: TOTAL 108        pass if the page contains this text
//   FAKE: exit2              behave as if Kane could not start (not signed in)
//   FAKE: silent-exit1       exit 1 without printing a single event (a broken install)
//   FAKE: hang               start, then never finish
//
// The real Kane CLI is exercised in the recorded runs under docs/runs/.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeZip } from './zip.mjs';

const args = process.argv.slice(2);
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
// Count the calls where Kane keeps its own files, so the count is not mistaken for a code change.
mkdirSync(join(process.cwd(), '.testmuai'), { recursive: true });
appendFileSync(join(process.cwd(), '.testmuai', 'fake-kane-calls'), args.join(' ') + '\n');

if (args[0] !== 'testmd' || args[1] !== 'run') { console.error(`fake kane: unsupported command ${args.join(' ')}`); process.exit(2); }
let spec;
try { spec = readFileSync(args[2], 'utf8'); } catch { console.error(`error: file not found: ${args[2]}`); process.exit(2); }
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : (spec.match(/^url:\s*(\S+)/m) ?? [])[1];

if (/^FAKE: exit2/m.test(spec)) { console.error('error: not signed in. Run `kane-cli login`.'); process.exit(2); }
if (/^FAKE: silent-exit1/m.test(spec)) { console.error("'kane-cli' is not recognized as an internal or external command"); process.exit(1); }

emit({ type: 'stream_start' });
if (/^FAKE: hang/m.test(spec)) { emit({ type: 'test_md_step_start', heading: 'Waiting forever' }); setInterval(() => {}, 1000); await new Promise(() => {}); }

const expected = [...spec.matchAll(/^EXPECT:\s*(.+)$/gm)].map((m) => m[1].trim());
let body = '';
try { body = await (await fetch(url)).text(); } catch (err) { console.error(`error: cannot open ${url}: ${err.message}`); process.exit(2); }

emit({ type: 'test_md_step_start', heading: 'Check the page' });
emit({ type: 'step_end', status: 'passed', remark: `navigate: Navigate to ${url}` });
const missing = expected.filter((t) => !body.includes(t));
const session = randomUUID();

if (!missing.length) {
  for (const t of expected) emit({ type: 'step_end', status: 'passed', remark: `assert: the page shows ${t}` });
  emit({ type: 'run_end', status: 'passed', credits_consumed: 12.5, test_url: `https://example.test/run/${session}` });
  emit({ type: 'test_md_done', overall_status: 'passed', share_url: `https://example.test/share/${session}`, session_id: session });
  process.exit(0);
}

const want = missing[0];
emit({ type: 'step_end', status: 'failed', remark: `assert: the page shows ${want}` });
const failure = `step: 0-1
status: failed
error:
  message: 'Final verification failed: the page does not show ${want}.'
page_state:
  url: ${url}/
title: The page does not show ${want}
triage:
  status: triaged
  rca:
    root_cause: The total is computed without the discount that was already applied,
      so the page shows the wrong amount.
    category: application_issue/logic_error
    confidence: 0.94
  severity: major
  suggested_fix:
    summary: Keep the applied discount when the total is recalculated.
`;
const pack = makeZip([
  ['tests/t1/result.yaml', 'status: failed\n', false],
  ['tests/t1/steps/1-0-1/failure.yaml', failure, true],
  ['tests/t1/steps/1-0-1/screenshot.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), false],
  ['tests/t1/logs/1-console.ndjson', JSON.stringify({ level: 'error', text: 'Uncaught TypeError: discount is undefined', step: '0-1' }) + '\n', false],
]);
mkdirSync(join(process.cwd(), '.testmuai', 'evidence'), { recursive: true });
writeFileSync(join(process.cwd(), '.testmuai', 'evidence', `${session}.evidence`), pack);
emit({ type: 'run_end', status: 'failed', credits_consumed: 20, test_url: `https://example.test/run/${session}` });
emit({ type: 'test_md_done', overall_status: 'failed', share_url: `https://example.test/share/${session}`, session_id: session });
process.exit(1);
