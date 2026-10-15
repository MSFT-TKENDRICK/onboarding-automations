// The write guard: nothing but the one armed create can ever write to StartRight, and a test run can never write to a
// non-local service.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, GuardError, liveWriteRefusal, isLoopback, underTest } from '../../skills/request-new-github-repository/scripts/lib/guard.mjs';
import { WRITE_PATH } from '../../skills/request-new-github-repository/scripts/lib/contract.mjs';

const LIVE = 'https://startright.app.prod.gitops.startclean.microsoft.com';
const LOCAL = 'http://127.0.0.1:5555';
const body = { a: 1, b: { c: [1, 2] } };
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof GuardError && e.code === code);

describe('browser interception', () => {
  const g = () => createGuard({ baseUrl: LIVE, env: {} });
  it('lets the browser read anything from the service', () => {
    assert.equal(g().classify({ method: 'GET', url: `${LIVE}/api/v1/resource/github/organizations` }).action, 'continue');
  });
  it('denies every browser write to the service, including the create path', () => {
    const guard = g();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(guard.classify({ method, url: `${LIVE}${WRITE_PATH}` }).action, 'fail', method);
      assert.equal(guard.classify({ method, url: `${LIVE}/anything` }).action, 'fail', method);
    }
    assert.equal(guard.classify({ method: 'POST', url: `${LIVE}${WRITE_PATH}` }).reason, 'blocked-create-from-browser');
    assert.equal(guard.stats().createsSent, 0);
  });
  it('allows writes only to the sign-in hosts', () => {
    const guard = g();
    assert.equal(guard.classify({ method: 'POST', url: 'https://login.microsoftonline.com/x/login' }).action, 'continue');
    assert.equal(guard.classify({ method: 'POST', url: 'https://github.com/session' }).action, 'continue');
    assert.equal(guard.classify({ method: 'POST', url: 'https://github.com/login/oauth/authorize' }).action, 'continue');
    assert.equal(guard.classify({ method: 'POST', url: 'https://github.com/orgs/x/repositories' }).action, 'fail');
    assert.equal(guard.classify({ method: 'POST', url: 'https://api.github.com/orgs/x/repos' }).action, 'fail');
    assert.equal(guard.classify({ method: 'POST', url: 'https://evil.example/login' }).action, 'fail');
    assert.equal(guard.classify({ method: 'POST', url: `https://github.com.evil.example/session` }).action, 'fail');
  });
  it('blocks heavy resources and telemetry reads', () => {
    const guard = g();
    assert.equal(guard.classify({ method: 'GET', url: `${LIVE}/x.png`, resourceType: 'Image' }).action, 'fail');
    assert.equal(guard.classify({ method: 'GET', url: 'https://www.clarity.ms/x' }).action, 'fail');
  });
});

describe('the one create', () => {
  const armed = (env = {}, baseUrl = LOCAL, opts = {}) => { const guard = createGuard({ baseUrl, env, ...opts }); return guard; };
  const url = (base) => `${base}${WRITE_PATH}`;

  it('is sent only when armed, to the create path, with the identical body, and only once', () => {
    const g = armed();
    throwsCode(() => g.authorizeCreate({ method: 'POST', url: url(LOCAL), body }), 'create_not_armed');
    g.armCreate({ expectedBody: body });
    g.authorizeCreate({ method: 'POST', url: url(LOCAL), body: { b: { c: [1, 2] }, a: 1 } });
    assert.equal(g.stats().createsSent, 1);
    throwsCode(() => g.authorizeCreate({ method: 'POST', url: url(LOCAL), body }), 'create_not_armed');
    assert.equal(g.stats().createsSent, 1);
  });
  it('refuses a different body, method, path or origin, and consumes the gate when it does', () => {
    for (const [label, args, code] of [
      ['body', { method: 'POST', url: url(LOCAL), body: { ...body, a: 2 } }, 'create_body_mismatch'],
      ['method', { method: 'PUT', url: url(LOCAL), body }, 'create_target_mismatch'],
      ['path', { method: 'POST', url: `${LOCAL}/other`, body }, 'create_target_mismatch'],
      ['origin', { method: 'POST', url: `http://127.0.0.1:9${WRITE_PATH}`, body }, 'create_target_mismatch'],
    ]) {
      const g = armed();
      g.armCreate({ expectedBody: body });
      throwsCode(() => g.authorizeCreate(args), code);
      throwsCode(() => g.authorizeCreate({ method: 'POST', url: url(LOCAL), body }), 'create_not_armed');
      assert.equal(g.stats().createsSent, 0, label);
    }
  });
  it('cannot be armed when submission is disabled (plan, status, options, verify)', () => {
    const g = armed({}, LOCAL, { allowSubmit: false });
    throwsCode(() => g.armCreate({ expectedBody: body }), 'submit_disabled');
    throwsCode(() => g.authorizeCreate({ method: 'POST', url: url(LOCAL), body }), 'submit_disabled');
    assert.equal(g.stats().everArmed, false);
  });
  it('records every decision in the ledger with its phase', () => {
    const g = armed();
    g.setPhase('submit');
    g.armCreate({ expectedBody: body });
    g.authorizeCreate({ method: 'POST', url: url(LOCAL), body });
    const w = g.stats().writes;
    assert.equal(w.length, 1);
    assert.deepEqual([w[0].phase, w[0].action, w[0].service, w[0].origin], ['submit', 'continue', true, 'node']);
  });
});

describe('kill switch: a test run can never write to a real service', () => {
  const testEnv = { NODE_TEST_CONTEXT: 'child-v8' };
  it('detects a test context and loopback hosts', () => {
    assert.equal(underTest(testEnv), true);
    assert.equal(underTest({}), false);
    assert.ok(isLoopback('http://127.0.0.1:1') && isLoopback('http://localhost:1'));
    assert.ok(!isLoopback(LIVE) && !isLoopback('http://127.0.0.1.evil.example') && !isLoopback('not a url'));
  });
  it('refuses the live service under test, in both arming and authorizing', () => {
    assert.match(liveWriteRefusal(LIVE, testEnv), /Refusing/);
    assert.equal(liveWriteRefusal(LIVE, {}), null);
    assert.equal(liveWriteRefusal(LOCAL, testEnv), null);
    const g = createGuard({ baseUrl: LIVE, env: testEnv });
    throwsCode(() => g.armCreate({ expectedBody: body }), 'test_environment_refuses_live_write');
    throwsCode(() => g.authorizeCreate({ method: 'POST', url: `${LIVE}${WRITE_PATH}`, body }), 'test_environment_refuses_live_write');
    assert.equal(g.stats().createsSent, 0);
  });
  it('is active in this very test process', () => {
    assert.equal(underTest(process.env), true, 'node --test must export NODE_TEST_CONTEXT');
    const g = createGuard({ baseUrl: LIVE });
    throwsCode(() => g.armCreate({ expectedBody: body }), 'test_environment_refuses_live_write');
  });
  it('cannot be defeated by lookalike hosts', () => {
    for (const host of ['http://localhost.evil.example', 'http://127.0.0.1.nip.io', 'https://startright.localhost.evil.example']) {
      const g = createGuard({ baseUrl: host, env: testEnv });
      throwsCode(() => g.armCreate({ expectedBody: body }), 'test_environment_refuses_live_write');
    }
  });
});
