import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { connectCdp, connectPipe } from '../../skills/request-new-github-repository/scripts/lib/cdp.mjs';

// --remote-debugging-pipe emulation: the browser reads NUL-terminated JSON on one pipe and writes on the other.
function fakePipeBrowser({ chunk = Infinity } = {}) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const seen = [];
  let buf = '';
  toBrowser.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      seen.push(msg);
      if (msg.method === 'Never.reply') continue;
      const out = Buffer.from(`${JSON.stringify({ method: 'Test.event', params: { before: msg.id } })}\0${JSON.stringify({ id: msg.id, result: { echo: msg.method } })}\0`);
      for (let o = 0; o < out.length; o += chunk) fromBrowser.write(out.subarray(o, o + chunk));
    }
  });
  return { toBrowser, fromBrowser, seen, hangUp: () => fromBrowser.end() };
}

// Minimal WebSocket server (text frames < 64 KiB) that answers CDP calls unless the method is "Never.reply".
async function fakeBrowser() {
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
        const opcode = buf[0] & 0x0f;
        buf = buf.subarray(off + 4 + len);
        if (opcode === 8) { socket.end(); return; }
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.method === 'Never.reply') continue;
        const out = Buffer.from(JSON.stringify({ id: msg.id, result: { echo: msg.method } }));
        const head = out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126, out.length >> 8, out.length & 0xff]);
        socket.write(Buffer.concat([head, out]));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`, close: () => { server.closeAllConnections?.(); server.close(); } };
}

const blockEventLoop = (ms) => { const until = performance.now() + ms; while (performance.now() < until); };

test('a response that arrived during an event-loop stall wins over the (late) timeout', async () => {
  const b = await fakeBrowser();
  const cdp = await connectCdp(b.url);
  try {
    const p = cdp.send('Page.enable', {}, undefined, { timeoutMs: 100 });
    blockEventLoop(400); // the reply is sitting in the socket buffer when the overdue timer fires
    assert.deepEqual(await p, { echo: 'Page.enable' });
  } finally { cdp.close(); b.close(); }
});

test('calls that never get a reply still time out', async () => {
  const b = await fakeBrowser();
  const cdp = await connectCdp(b.url);
  try {
    const t = performance.now();
    await assert.rejects(cdp.send('Never.reply', {}, undefined, { timeoutMs: 150 }), (e) => e.code === 'cdp_timeout');
    assert.ok(performance.now() - t < 2000);
    blockEventLoop(1500); // a stall while nothing is pending is harmless
    await assert.rejects(cdp.send('Never.reply', {}, undefined, { timeoutMs: 100 }), (e) => e.code === 'cdp_timeout');
  } finally { cdp.close(); b.close(); }
});

test('a stalled call with no reply times out after one short grace period', async () => {
  const b = await fakeBrowser();
  const cdp = await connectCdp(b.url);
  try {
    const p = cdp.send('Never.reply', {}, undefined, { timeoutMs: 100 });
    blockEventLoop(1500);
    const t = performance.now();
    await assert.rejects(p, (e) => e.code === 'cdp_timeout');
    assert.ok(performance.now() - t < 3000);
  } finally { cdp.close(); b.close(); }
});

test('pipe transport: NUL-framed messages, split across chunks, events and replies', async () => {
  const b = fakePipeBrowser({ chunk: 7 });
  const cdp = connectPipe(b.toBrowser, b.fromBrowser);
  const events = [];
  cdp.on('Test.event', (p) => events.push(p.before));
  try {
    const [r1, r2] = await Promise.all([cdp.send('Browser.getVersion'), cdp.send('Page.enable', {}, 'S1')]);
    assert.deepEqual(r1, { echo: 'Browser.getVersion' });
    assert.deepEqual(r2, { echo: 'Page.enable' });
    assert.equal(b.seen[1].sessionId, 'S1');
    assert.deepEqual(events.sort(), [1, 2]);
  } finally { cdp.close(); }
});

test('pipe transport: the browser hanging up rejects pending calls and waiters', async () => {
  const b = fakePipeBrowser();
  const cdp = connectPipe(b.toBrowser, b.fromBrowser);
  const call = cdp.send('Never.reply', {}, undefined, { timeoutMs: 60000 });
  const wait = cdp.waitFor('Page.loadEventFired', () => true, { timeoutMs: 60000 });
  b.hangUp();
  await assert.rejects(call, /closed/);
  await assert.rejects(wait, /closed/);
  assert.equal(cdp.closed, true);
  await assert.rejects(cdp.send('Page.enable'), /closed/);
});

test('close() rejects waiters so no timer keeps the process alive', async () => {
  const b = fakePipeBrowser();
  const cdp = connectPipe(b.toBrowser, b.fromBrowser);
  const wait = cdp.waitFor('Page.loadEventFired', () => true, { timeoutMs: 60000 });
  const t = performance.now();
  cdp.close();
  await assert.rejects(wait, /closed/);
  assert.ok(performance.now() - t < 500);
  assert.equal(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, 0);
});

test('websocket transport: close() also rejects waiters', async () => {
  const b = await fakeBrowser();
  const cdp = await connectCdp(b.url);
  const wait = cdp.waitFor('Page.loadEventFired', () => true, { timeoutMs: 60000 });
  cdp.close(); b.close();
  await assert.rejects(wait, /closed/);
});
