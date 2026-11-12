// Records the demo stage as timestamped JPEG frames (headless Chrome screencast, no deps).
// Frames arrive only when the screen changes; frames.ndjson keeps each frame's wall-clock time,
// so the video can be rebuilt at true speed (or sped up, with an on-screen speed marker).
//
// Usage: node tools/demo-stage/record.mjs --url http://localhost:4800 --out <dir> [--minutes 45]
// Stop it early by creating <dir>/STOP.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../../src/cdp.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://localhost:4800');
const OUT = resolve(arg('out', 'take'));
const MINUTES = Number(arg('minutes', 45));
const CHROME = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const PORT = 9666;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(OUT, 'frames'), { recursive: true });
rmSync(join(OUT, 'STOP'), { force: true });
const profile = join(tmpdir(), `signoff-recorder-${process.pid}`);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1920,1080', '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(250); }
}
const page = await connect(target.webSocketDebuggerUrl);
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_ });
await sleep(2500);

let n = 0, lastSaved = 0;
const t0 = Date.now();
const MIN_GAP = 1000 / Number(arg('fps', 10)); // keep at most this many frames per second
page.on((m) => {
  if (m.method !== 'Page.screencastFrame') return;
  const now = Date.now();
  if (now - lastSaved < MIN_GAP) { page.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}); return; }
  lastSaved = now;
  const file = String(++n).padStart(6, '0') + '.jpg';
  writeFileSync(join(OUT, 'frames', file), Buffer.from(m.params.data, 'base64'));
  appendFileSync(join(OUT, 'frames.ndjson'), JSON.stringify({ file, t: Date.now() }) + '\n');
  page.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
});
await page.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
writeFileSync(join(OUT, 'recording.json'), JSON.stringify({ url: URL_, startedAt: t0 }, null, 2));
console.log(`recording ${URL_} -> ${OUT}`);

while (!existsSync(join(OUT, 'STOP')) && Date.now() - t0 < MINUTES * 60_000) await sleep(500);
await page.send('Page.stopScreencast').catch(() => {});
appendFileSync(join(OUT, 'frames.ndjson'), JSON.stringify({ end: true, t: Date.now() }) + '\n');
console.log(`stopped: ${n} frames over ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(0);
