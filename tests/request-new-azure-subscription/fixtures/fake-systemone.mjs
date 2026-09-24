// Fake System One (TypeSafe-compatible) server on 127.0.0.1 for integration tests. Records every request body
// and answers through a configurable responder: (question, body) => answer | {status, raw} | 'hang'.
import http from 'node:http';

// A well-formed choice answer: `probs` maps criteria keys to probabilities (the rest share what remains).
export function answer(question, probs) {
  const keys = Object.keys(question.criteria);
  const given = Object.values(probs).reduce((a, b) => a + b, 0);
  const rest = keys.filter((k) => !(k in probs));
  const p = Object.fromEntries(keys.map((k) => [k, k in probs ? probs[k] : (1 - given) / rest.length]));
  const choice = keys.reduce((a, b) => (p[b] > p[a] ? b : a));
  return { type: 'choice', choice, confidence: p[choice], probabilities: p };
}

// Criteria key whose text matches `re` (e.g. the option or control the test wants to win).
export const keyOf = (question, re) => Object.keys(question.criteria).find((k) => re.test(question.criteria[k]));

export async function startFakeSystemOne(responder = () => 'hang') {
  const hits = [];
  const sockets = new Set();
  const state = { responder };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      hits.push({ method: req.method, path: req.url, raw, body });
      const [name, question] = Object.entries(body?.questions ?? {})[0] ?? [];
      const r = await state.responder(question ?? {}, body, name);
      if (r === 'hang') return;
      if (r && r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(r.raw ?? ''); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { [name]: r } }));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    state,
    async close() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  };
}
