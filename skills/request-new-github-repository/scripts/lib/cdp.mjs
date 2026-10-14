// Minimal zero-dependency Chrome DevTools Protocol client over --remote-debugging-pipe (default: no TCP port,
// and the browser exits when this process dies) or a WebSocket (Node >= 22 global WebSocket).

// Transport-agnostic core. transport: { write(json), close() }; feed replies/events to receive(), hang-ups to hangUp().
function createClient(transport, { callTimeoutMs = 45000 } = {}) {
  let nextId = 0;
  const pending = new Map();
  const waiters = new Set();
  const listeners = new Map();
  let closed = false;

  function shutdown(reason) {
    if (closed) return;
    closed = true;
    const err = () => new Error(`CDP connection closed${reason ? ` (${reason})` : ''}`);
    for (const p of pending.values()) p.reject(err());
    pending.clear();
    for (const w of [...waiters]) w(err());
    waiters.clear();
  }

  function receive(msg) {
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { cdp: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    for (const key of [`${msg.sessionId ?? ''}:${msg.method}`, `*:${msg.method}`]) {
      for (const fn of listeners.get(key) ?? []) {
        try { fn(msg.params, msg.sessionId); } catch (err) { queueMicrotask(() => { throw err; }); }
      }
    }
  }

  const client = {
    // Every call is bounded: a wedged target (paused worker, blocked renderer) must never hang the CLI.
    send(method, params = {}, sessionId, { timeoutMs = callTimeoutMs } = {}) {
      if (closed) return Promise.reject(new Error('CDP connection closed'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        // Timers run before I/O in each event-loop turn, so after a stall (sync fs/process work, an overloaded
        // machine) every overdue timer would fire before replies already buffered are read. Yield one I/O phase
        // before failing, and grant a stalled call one short grace period.
        const armedAt = performance.now();
        let graced = false;
        const fire = () => setImmediate(() => {
          if (!pending.has(id)) return;
          const late = performance.now() - armedAt - timeoutMs;
          if (!graced && late > 50) { graced = true; t = setTimeout(fire, late > 1000 ? 1000 : 250); return; }
          pending.delete(id);
          reject(Object.assign(new Error(`${method}: CDP call timed out after ${timeoutMs}ms`), { code: 'cdp_timeout' }));
        });
        let t = setTimeout(fire, timeoutMs);
        const done = (fn) => (v) => { clearTimeout(t); fn(v); };
        pending.set(id, { resolve: done(resolve), reject: done(reject), method });
        try { transport.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); } catch (e) {
          pending.delete(id); clearTimeout(t); reject(new Error(`CDP connection closed (${e.message})`));
        }
      });
    },
    on(method, fn, sessionId) {
      const key = `${sessionId ?? '*'}:${method}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
    // Rejected on close, so a pending waiter never keeps the process alive after the session ends.
    waitFor(method, predicate = () => true, { sessionId, timeoutMs = 30000 } = {}) {
      if (closed) return Promise.reject(new Error('CDP connection closed'));
      return new Promise((resolve, reject) => {
        const finish = (fn, v) => { clearTimeout(t); off(); waiters.delete(abort); fn(v); };
        const abort = (err) => finish(reject, err);
        const off = client.on(method, (params) => { if (predicate(params)) finish(resolve, params); }, sessionId);
        const t = setTimeout(() => finish(reject, new Error(`Timed out waiting for ${method}`)), timeoutMs);
        waiters.add(abort);
      });
    },
    get closed() { return closed; },
    close() {
      shutdown();
      try { transport.close(); } catch {}
    },
  };
  return { client, receive, hangUp: shutdown };
}

// CDP over the browser's --remote-debugging-pipe: we write to its fd 3 and read NUL-terminated JSON from fd 4.
export function connectPipe(toBrowser, fromBrowser, opts = {}) {
  const { client, receive, hangUp } = createClient({
    write: (json) => { toBrowser.write(`${json}\0`); },
    close: () => { toBrowser.destroy(); fromBrowser.destroy(); },
  }, opts);
  const parts = [];
  fromBrowser.on('data', (chunk) => {
    let start = 0;
    for (let i = chunk.indexOf(0); i >= 0; i = chunk.indexOf(0, start)) {
      parts.push(chunk.subarray(start, i));
      const text = Buffer.concat(parts).toString('utf8');
      parts.length = 0;
      start = i + 1;
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      receive(msg);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  });
  for (const ev of ['end', 'close']) fromBrowser.on(ev, () => hangUp('browser pipe closed'));
  fromBrowser.on('error', (e) => hangUp(e.message));
  toBrowser.on('error', (e) => hangUp(e.message));
  return client;
}

export async function connectCdp(wsUrl, { timeoutMs = 15000, ...opts } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(`CDP connect failed: ${e.message ?? 'error'}`)); }, { once: true });
  });
  const { client, receive, hangUp } = createClient({ write: (json) => ws.send(json), close: () => ws.close() }, opts);
  ws.addEventListener('message', (ev) => receive(JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))));
  ws.addEventListener('close', () => hangUp('websocket closed'));
  return client;
}
// Session-scoped helper bound to one attached page target.
export function pageSession(cdp, sessionId) {
  return {
    sessionId,
    send: (method, params, opts) => cdp.send(method, params, sessionId, opts),
    on: (method, fn) => cdp.on(method, fn, sessionId),
    waitFor: (method, pred, opts = {}) => cdp.waitFor(method, pred, { ...opts, sessionId }),
    // Run a self-contained function in the page with JSON-serializable args; one CDP round trip.
    async call(fn, ...args) {
      const expression = `(${fn})(...${JSON.stringify(args)})`;
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)
        .catch((e) => { throw e.code === 'cdp_timeout' ? Object.assign(new Error(`In-page call ${fn.name || 'anonymous'} timed out`), { code: 'cdp_timeout' }) : e; });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`In-page error: ${d.exception?.description?.split('\n')[0] ?? d.text}`);
      }
      return r.result?.value;
    },
  };
}

