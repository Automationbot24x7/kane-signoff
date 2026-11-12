// A tiny Chrome DevTools Protocol client (Node 22+ global WebSocket). Used when
// Kane drives a browser you started yourself ("cdpEndpoint" in signoff.config.json).

export async function connectBrowser(endpoint) {
  const info = await (await fetch(new URL('/json/version', endpoint))).json();
  return connect(info.webSocketDebuggerUrl);
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else for (const l of listeners) l(m);
    });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      close: () => ws.close(),
    }), { once: true });
  });
}

/** Clear cookies, local storage, IndexedDB and caches for the app's origin, so every spec starts clean. */
export async function clearOrigin(endpoint, appUrl) {
  const b = await connectBrowser(endpoint);
  try {
    // Chrome only accepts this from a page session, not the browser session.
    const { targetInfos } = await b.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) return;
    const { sessionId } = await b.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    try { await b.send('Storage.clearDataForOrigin', { origin: new URL(appUrl).origin, storageTypes: 'all' }, sessionId); }
    finally { await b.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  } finally { b.close(); }
}
