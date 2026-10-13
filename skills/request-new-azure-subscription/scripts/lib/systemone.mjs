// Minimal TypeSafe-compatible System One client (TypeSafe Jev, or a local CLM `clm-serve`).
// Zero dependencies. node:http/https (not fetch) so proxy environment variables cannot reroute requests.
// Every failure is "no answer": callers fall back to their deterministic result.
import http from 'node:http';
import https from 'node:https';

const LOOPBACK = new Set(['127.0.0.1', '[::1]']);
const MAX_REQUEST = 32 * 1024;
const MAX_RESPONSE = 64 * 1024;
const TOLERANCE = 0.02;

// Parse first, then check the canonical hostname (the WHATWG parser folds 127.1, hex and integer IPv4 forms).
export function endpointPolicy(raw, env = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: 'unparsable endpoint' }; }
  if (u.username || u.password) return { ok: false, reason: 'credentials in endpoint URL' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'endpoint must be http(s)' };
  const host = u.hostname.toLowerCase();
  if (LOOPBACK.has(host)) return { ok: true, mode: 'local', url: u };
  const allow = String(env.MCAPS_SYSTEMONE_ALLOW_REMOTE ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.includes(host)) return { ok: false, reason: `endpoint host ${host} is not loopback (127.0.0.1 or [::1]) and not in MCAPS_SYSTEMONE_ALLOW_REMOTE` };
  if (u.protocol !== 'https:') return { ok: false, reason: 'remote endpoints must use https' };
  return { ok: true, mode: 'remote', url: u };
}

export function validateChoice(ans, criteria) {
  const bad = (why) => ({ ok: false, error: 'invalid_answer', why });
  if (!ans || ans.type !== 'choice' || typeof ans.probabilities !== 'object' || !ans.probabilities) return bad('shape');
  const keys = Object.keys(ans.probabilities);
  if (keys.length !== criteria.length || !criteria.every((k) => Object.hasOwn(ans.probabilities, k))) return bad('keys');
  const ps = criteria.map((k) => ans.probabilities[k]);
  if (!ps.every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1)) return bad('range');
  if (Math.abs(ps.reduce((a, b) => a + b, 0) - 1) > TOLERANCE) return bad('sum');
  const max = Math.max(...ps);
  const leaders = criteria.filter((k) => ans.probabilities[k] === max);
  if (leaders.length !== 1 || ans.choice !== leaders[0]) return bad('argmax');
  if (typeof ans.confidence !== 'number' || Math.abs(ans.confidence - max) > TOLERANCE) return bad('confidence');
  const ranked = criteria.map((k) => [k, ans.probabilities[k]]).sort((a, b) => b[1] - a[1]);
  return { ok: true, choice: ans.choice, p: max, margin: max - (ranked[1]?.[1] ?? 0), probabilities: Object.fromEntries(ranked) };
}

// Masks anything that could identify a person, tenant or secret before it leaves the process.
export function redactor(known = []) {
  const lits = [...new Set(known.filter((v) => typeof v === 'string' && v.trim().length >= 3).map((v) => v.trim()))].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const litRe = lits.length ? new RegExp(lits.map(esc).join('|'), 'gi') : null;
  return (s) => {
    let t = String(s ?? '');
    if (litRe) t = t.replace(litRe, '[input]');
    return t
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[guid]')
      .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, '[token]')
      .replace(/\d{7,}/g, '[number]');
  };
}

function post(url, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const mod = url.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const req = mod.request({
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
      path: `${url.pathname.replace(/\/+$/, '')}/v1/systemone`, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); return finish({ ok: false, error: 'redirect' }); }
      if (res.statusCode !== 200) { res.destroy(); return finish({ ok: false, error: `http_${res.statusCode}` }); }
      let size = 0; const chunks = [];
      res.on('data', (c) => { size += c.length; if (size > MAX_RESPONSE) { res.destroy(); finish({ ok: false, error: 'response_too_large' }); } else chunks.push(c); });
      res.on('end', () => { try { finish({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { finish({ ok: false, error: 'invalid_json' }); } });
      res.on('error', () => finish({ ok: false, error: 'connection' }));
    });
    const timer = setTimeout(() => { req.destroy(); finish({ ok: false, error: 'timeout' }); }, timeoutMs);
    req.on('error', () => finish({ ok: false, error: 'connection' }));
    req.end(body);
  });
}

// Returns null when not configured (the default). Throws for a configured but disallowed endpoint.
export function createSystemOne(env = process.env) {
  const raw = env.MCAPS_SYSTEMONE_URL;
  if (!raw) return null;
  const pol = endpointPolicy(raw, env);
  if (!pol.ok) throw Object.assign(new Error(`System One endpoint refused: ${pol.reason}`), { code: 'systemone_endpoint' });
  const model = env.MCAPS_SYSTEMONE_MODEL || 'clm-latest';
  const key = env.MCAPS_SYSTEMONE_KEY || env.TYPESAFE_API_KEY || '';
  const timeoutMs = Math.max(50, Number(env.MCAPS_SYSTEMONE_TIMEOUT_MS) || 2000);
  let calls = 0;
  return {
    mode: pol.mode,
    get calls() { return calls; },
    // One closed-set question. `criteria` maps opaque labels to descriptions.
    async choose(name, state, instructions, criteria) {
      const body = JSON.stringify({ model, state, questions: { [name]: { type: 'choice', instructions, criteria } } });
      if (Buffer.byteLength(body) > MAX_REQUEST) return { ok: false, error: 'request_too_large' };
      calls++;
      const r = await post(pol.url, body, key ? { authorization: `Bearer ${key}` } : {}, timeoutMs);
      if (!r.ok) return r;
      const answers = r.json?.answers;
      if (!answers || typeof answers !== 'object' || Object.keys(answers).length !== 1 || !Object.hasOwn(answers, name)) return { ok: false, error: 'invalid_answer', why: 'answers' };
      return validateChoice(answers[name], Object.keys(criteria));
    },
  };
}
