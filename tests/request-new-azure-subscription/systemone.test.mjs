import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { endpointPolicy, validateChoice, redactor, createSystemOne } from '../../skills/request-new-azure-subscription/scripts/lib/systemone.mjs';

describe('endpointPolicy', () => {
  const ok = (url, env = {}) => endpointPolicy(url, env);
  it('accepts loopback IP literals only, after URL canonicalization', () => {
    assert.equal(ok('http://127.0.0.1:8700').ok, true);
    assert.equal(ok('http://[::1]:8700').ok, true);
    assert.equal(ok('http://127.1:8700').ok, true, '127.1 canonicalizes to 127.0.0.1');
    assert.equal(ok('http://0x7f.1:8700').ok, true, 'hex form canonicalizes to 127.0.0.1');
  });
  it('rejects names and non-loopback addresses without an explicit remote allowlist', () => {
    for (const u of ['http://localhost:8700', 'http://[::ffff:127.0.0.1]:8700', 'http://10.0.0.5:8700', 'https://api.typesafe.ai', 'http://127.0.0.2:8700']) {
      assert.equal(ok(u).ok, false, u);
    }
  });
  it('allows only listed https remote hosts', () => {
    const env = { MCAPS_SYSTEMONE_ALLOW_REMOTE: 'api.typesafe.ai' };
    assert.equal(ok('https://api.typesafe.ai', env).ok, true);
    assert.equal(ok('http://api.typesafe.ai', env).ok, false, 'remote must be https');
    assert.equal(ok('https://evil.example', env).ok, false);
    assert.equal(ok('https://api.typesafe.ai.evil.example', env).ok, false);
  });
  it('rejects credentials, other schemes and garbage', () => {
    for (const u of ['http://u:p@127.0.0.1:8700', 'file:///etc/passwd', 'not a url', '']) assert.equal(ok(u).ok, false, u);
  });
});

describe('validateChoice', () => {
  const crit = ['a', 'b', 'none'];
  const good = { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.07, none: 0.03 } };
  it('accepts a well-formed answer', () => assert.deepEqual(validateChoice(good, crit).ok, true));
  const bad = {
    'wrong type': { ...good, type: 'noul' },
    'missing key': { ...good, probabilities: { a: 0.9, b: 0.1 } },
    'extra key': { ...good, probabilities: { ...good.probabilities, c: 0 } },
    negative: { ...good, probabilities: { a: 1.1, b: -0.1, none: 0 } },
    'not normalized': { ...good, probabilities: { a: 0.5, b: 0.1, none: 0.1 } },
    'choice not argmax': { ...good, choice: 'b' },
    'confidence mismatch': { ...good, confidence: 0.5 },
    tie: { type: 'choice', choice: 'a', confidence: 0.45, probabilities: { a: 0.45, b: 0.45, none: 0.1 } },
    'non-finite': { ...good, probabilities: { a: NaN, b: 0.07, none: 0.03 } },
    'choice out of set': { ...good, choice: 'z' },
  };
  for (const [name, ans] of Object.entries(bad)) it(`rejects ${name}`, () => assert.equal(validateChoice(ans, crit).ok, false));
});

describe('redactor', () => {
  it('masks emails, GUIDs, URLs, long digit runs, token-like runs and known input values', () => {
    const r = redactor(['Contoso Secret Project']);
    const out = r('mail a.b@contoso.com id 11111111-1111-4111-8111-111111111111 see https://x.y/z?q=1 acct 123456789012 tok eyJhbGciOiJIUzI1NiJ9abcdefghijk Contoso Secret Project ok');
    for (const leak of ['a.b@contoso.com', '11111111-1111', 'https://x.y', '123456789012', 'eyJhbGci', 'Contoso Secret Project']) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
    assert.match(out, /\bok$/);
  });
  it('keeps ordinary labels intact', () => {
    assert.equal(redactor([])('(UTC-08:00) Pacific Time (US & Canada)'), '(UTC-08:00) Pacific Time (US & Canada)');
  });
});

describe('createSystemOne against a fake TypeSafe-compatible server', () => {
  let server; let port; const hits = []; let reply = () => ({ status: 200, body: {} });
  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        hits.push({ url: req.url, headers: req.headers, body: raw });
        const r = reply(JSON.parse(raw || '{}'));
        if (r.hang) return;
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());
  const env = () => ({ MCAPS_SYSTEMONE_URL: `http://127.0.0.1:${port}` });
  const answer = (probs) => { const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0]; return { type: 'choice', choice, confidence: probs[choice], probabilities: probs }; };

  it('is disabled unless MCAPS_SYSTEMONE_URL is set', () => {
    assert.equal(createSystemOne({}), null);
  });
  it('refuses a disallowed endpoint instead of calling it', () => {
    assert.throws(() => createSystemOne({ MCAPS_SYSTEMONE_URL: 'http://localhost:1' }), /endpoint/i);
  });
  it('posts the TypeSafe wire format and returns the validated distribution', async () => {
    reply = (b) => ({ status: 200, body: { model: b.model, answers: { pick: answer({ a: 0.95, b: 0.04, none: 0.01 }) }, usage: { input_tokens: 5, output_tokens: 0 } } });
    const so = createSystemOne({ ...env(), MCAPS_SYSTEMONE_KEY: 'k1' });
    const r = await so.choose('pick', { slot: 'x' }, 'Which?', { a: 'A', b: 'B', none: 'None' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.choice, 'a');
    const h = hits.at(-1);
    assert.equal(h.url, '/v1/systemone');
    assert.equal(h.headers.authorization, 'Bearer k1');
    const body = JSON.parse(h.body);
    assert.equal(body.model, 'clm-latest');
    assert.deepEqual(body.questions.pick, { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B', none: 'None' } });
  });
  it('sends no Authorization header without a key', async () => {
    reply = () => ({ status: 200, body: { answers: { pick: answer({ a: 0.95, none: 0.05 }) } } });
    await createSystemOne(env()).choose('pick', 's', 'q', { a: 'A', none: 'N' });
    assert.equal(hits.at(-1).headers.authorization, undefined);
  });
  it('treats redirects, HTTP errors, invalid JSON, malformed answers and oversize bodies as no answer', async () => {
    const so = createSystemOne(env());
    for (const r of [
      { status: 302, headers: { location: 'http://10.0.0.1/' }, body: {} },
      { status: 500, body: { error: 'x' } },
      { status: 200, body: 'not json' },
      { status: 200, body: { answers: { pick: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1 } } } } },
      { status: 200, body: { answers: {} } },
      { status: 200, body: 'x'.repeat(70 * 1024) },
    ]) {
      reply = () => r;
      const out = await so.choose('pick', 's', 'q', { a: 'A', none: 'N' });
      assert.equal(out.ok, false, JSON.stringify(r).slice(0, 80));
      assert.ok(!JSON.stringify(out).includes('not json'), 'response bodies never leak into errors');
    }
  });
  it('times out without retrying', async () => {
    reply = () => ({ hang: true });
    const before = hits.length;
    const t0 = Date.now();
    const out = await createSystemOne({ ...env(), MCAPS_SYSTEMONE_TIMEOUT_MS: '300' }).choose('pick', 's', 'q', { a: 'A', none: 'N' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'timeout');
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(hits.length, before + 1, 'exactly one attempt');
  });
  it('refuses oversize requests before sending', async () => {
    const before = hits.length;
    const out = await createSystemOne(env()).choose('pick', 'x'.repeat(40 * 1024), 'q', { a: 'A', none: 'N' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'request_too_large');
    assert.equal(hits.length, before);
  });
});
