// Demo stage: one screen that shows a real Signoff run live, for recording the demo video.
//   left   the coding agent's own output (its stream-json log, rendered as it arrives)
//   right  the Chrome that Kane CLI is driving (live CDP screencast) and Signoff's verdicts
// Nothing here is simulated: it only reads files and a browser that the real run produces.
//
// Usage:
//   node tools/demo-stage/stage.mjs --project <dir> --agent <agent.ndjson> --cdp http://127.0.0.1:9555 \
//        [--port 4800] [--ticket "..."] [--model "..."]
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBrowser } from '../../src/cdp.mjs';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const PROJECT = resolve(arg('project', '.'));
const AGENT = arg('agent', null) && resolve(arg('agent'));
const CDP = arg('cdp', 'http://127.0.0.1:9555');
const PORT = Number(arg('port', 4800));
const TICKET = arg('ticket', '');
const MODEL = arg('model', '');
const HERE = dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();
const SINCE = Number(arg('since', startedAt)); // show ledger/live entries newer than this (ms); 0 = everything

// ---------- the coding agent's log ----------
const projectFwd = PROJECT.split('\\').join('/');
// Never show the machine's user folder on screen.
// Covers Windows (C:\Users\x, C:/Users/x), Git Bash (/c/Users/x), macOS (/Users/x) and Linux (/home/x) homes,
// and shortens long temp folders.
const scrub = (t) => String(t ?? '').split(PROJECT).join('.').split(projectFwd).join('.')
  .replace(/(?:[A-Za-z]:|\/[a-zA-Z](?=\/Users\b))?[\\/]+(?:Users|home)[\\/]+[^\\/\s"']+/g, '~')
  .replace(/AppData[\\/]+Local[\\/]+Temp[\\/]+[^\s"']*/g, 'AppData/Local/Temp/…');
const shortPath = (p) => String(p ?? '').split('\\').join('/').replace(projectFwd + '/', '').replace(projectFwd, '.');

function toolLine(c) {
  const i = c.input ?? {};
  switch (c.name) {
    case 'Edit': case 'MultiEdit': return { icon: '✎', text: `edit ${shortPath(i.file_path)}` };
    case 'Write': return { icon: '✎', text: `write ${shortPath(i.file_path)}` };
    case 'Read': return { icon: '·', text: `read ${shortPath(i.file_path)}` };
    case 'Grep': return { icon: '·', text: `search "${i.pattern}"${i.path ? ` in ${shortPath(i.path)}` : ''}` };
    case 'Glob': return { icon: '·', text: `list ${i.pattern}` };
    case 'Bash': case 'PowerShell': {
      let cmd = String(i.command ?? '').replace(/^cd\s+("[^"]+"|\S+)\s*&&\s*/, '').split('\n')[0];
      return { icon: '$', text: cmd.length > 120 ? cmd.slice(0, 117) + '…' : cmd };
    }
    case 'TodoWrite': return null;
    default: return { icon: '·', text: c.name };
  }
}

function readAgent() {
  if (!AGENT || !existsSync(AGENT)) return { items: [], status: 'waiting' };
  const items = [];
  let status = 'working', cost = null;
  const uses = new Map();
  for (const line of readFileSync(AGENT, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'text' && c.text.trim()) items.push({ kind: 'say', text: scrub(c.text.trim()) });
        if (c.type === 'tool_use') { uses.set(c.id, c); const t = toolLine(c); if (t) items.push({ kind: 'tool', icon: t.icon, text: scrub(t.text) }); }
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'text' && /Stop hook feedback/.test(c.text)) items.push({ kind: 'hook', text: scrub(c.text.replace(/^Stop hook feedback:\s*/, '').trim()) });
        if (c.type === 'tool_result') {
          const t = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          const m = t.match(/Signoff: ([^"\\]+)/);
          if (m) items.push({ kind: 'guard', text: scrub(`Blocked by Signoff: ${m[1].trim()}`) });
        }
      }
    } else if (e.type === 'system' && e.subtype === 'informational' && /Stop says:/.test(e.content ?? '')) {
      items.push({ kind: 'signoff', text: scrub(e.content.replace(/^Stop says:\s*/, '')) });
    } else if (e.type === 'result') {
      status = 'done'; cost = e.total_cost_usd ?? null;
    }
  }
  return { items, status, cost };
}

// ---------- Signoff state ----------
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
function readSignoff() {
  const live = readJson(join(PROJECT, '.signoff', 'live.json'), null);
  const ledgerPath = join(PROJECT, '.signoff', 'ledger.ndjson');
  const ledger = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && new Date(e.ts).getTime() >= SINCE - 1000)
    : [];
  const cfg = readJson(join(PROJECT, 'signoff.config.json'), {});
  const fresh = live && new Date(live.updated).getTime() >= SINCE - 1000 ? live : null;
  return { live: fresh, ledger, config: { blind: !!cfg.blind, maxRounds: cfg.maxRounds ?? 4 } };
}

// ---------- Kane's browser, relayed ----------
let frame = null, frameAt = 0, pageUrl = '', relayOk = false;
async function relay() {
  for (;;) {
    try {
      const b = await connectBrowser(CDP);
      const { targetInfos } = await b.send('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      if (!page) { b.close(); await sleep(1000); continue; }
      const { sessionId } = await b.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      let alive = true;
      b.on((m) => {
        if (m.method === 'Page.screencastFrame' && m.sessionId === sessionId) {
          frame = Buffer.from(m.params.data, 'base64'); frameAt = Date.now();
          b.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, sessionId).catch(() => {});
        }
        if (m.method === 'Target.detachedFromTarget' || m.method === 'Inspector.detached') alive = false;
        if (m.method === 'Page.frameNavigated' && m.sessionId === sessionId && !m.params.frame.parentId) pageUrl = m.params.frame.url;
      });
      await b.send('Page.enable', {}, sessionId);
      await b.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 }, sessionId);
      relayOk = true;
      while (alive) {
        await sleep(1500);
        const t = await b.send('Target.getTargets').catch(() => null);
        const p = t?.targetInfos.find((x) => x.targetId === page.targetId);
        if (!p) alive = false; else pageUrl = p.url;
      }
      b.close();
    } catch { relayOk = false; await sleep(1500); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
relay();

// ---------- server ----------
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (url.pathname === '/api/state') {
    return send(200, JSON.stringify({ startedAt, now: Date.now(), ticket: TICKET, model: MODEL, agent: readAgent(), signoff: readSignoff(), browser: { url: pageUrl, frameAt, relayOk } }), 'application/json');
  }
  if (url.pathname === '/kane.jpg') return frame ? send(200, frame, 'image/jpeg') : send(404, '', 'text/plain');
  if (url.pathname === '/' || url.pathname === '/stage.html') return send(200, readFileSync(join(HERE, 'stage.html')), 'text/html; charset=utf-8');
  send(404, 'not found', 'text/plain');
}).listen(PORT, '127.0.0.1', () => console.log(`stage on http://localhost:${PORT}  project=${PROJECT}`));
