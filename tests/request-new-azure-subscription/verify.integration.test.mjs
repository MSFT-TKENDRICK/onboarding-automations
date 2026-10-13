// `verify` end to end: the real CLI and a real headless browser against the mock portal and its variants.
// Every variant must refute exactly the assumption it breaks, with concrete evidence, and nothing may ever be written.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockPortal, DEFAULTS } from './fixtures/mock-portal.mjs';
import { run } from '../../skills/request-new-azure-subscription/scripts/mcaps-subscription.mjs';
import { findBrowser } from '../../skills/request-new-azure-subscription/scripts/lib/browser.mjs';

let skip = false;
try { findBrowser(); } catch { skip = 'no Chromium-family browser found'; }

const SIGN_IN = '/Account/Login/ExternalLogin';
const SCOPED = ['--purpose', 'Hybrid', '--type', 'internal'];

async function withMock(overrides, fn, { env: extra = {} } = {}) {
  const m = await startMockPortal({ users: structuredClone(DEFAULTS.users), ...overrides });
  const home = mkdtempSync(join(tmpdir(), 'mcaps-verify-'));
  const env = { ...process.env, MCAPS_PORTAL_URL: m.formUrl, MCAPS_SKILL_HOME: home, MCAPS_LOG_FILE: join(home, 'run.log'), MCAPS_EPHEMERAL: '1', MCAPS_TIMEZONE: 'America/Los_Angeles', ...extra };
  delete env.MCAPS_PROFILE_DIR;
  const verify = (...args) => run(['verify', ...args], { env });
  try { await fn({ m, verify, home }); } catch (e) {
    try { e.message += `\n--- driver log ---\n${readFileSync(join(home, 'run.log'), 'utf8').split('\n').slice(-40).join('\n')}`; } catch {}
    throw e;
  } finally {
    await m.close();
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
  }
}

const byId = (out) => Object.fromEntries(out.checks.map((c) => [c.id, c]));
const nonSignInWrites = (m) => m.state.writes.filter((w) => w.path !== SIGN_IN);

describe('verify against the mock portal', { skip, concurrency: 2, timeout: 600000 }, () => {
  it('the default mock passes every check, writes nothing and warns that it is not the live portal', () => withMock({}, async ({ m, verify, home }) => {
    const r = await verify();
    const c = byId(r.out);
    assert.equal(r.code, 0, JSON.stringify(r.out, null, 1));
    assert.equal(r.out.ok, true);
    assert.deepEqual(r.out.checks.map((x) => x.id), ['portal_user', 'allowance_labels', 'field_ids', 'validators', 'timezone_default', 'writes_blocked']);
    for (const x of r.out.checks) assert.equal(x.pass, true, `${x.id}: ${x.detail}`);
    assert.equal(r.out.portal.url, m.formUrl);
    assert.equal(r.out.portal.live, false);
    assert.match(r.out.next, /not the live portal/i);
    assert.deepEqual(r.out.selections.types, ['internal', 'external']);
    assert.equal(r.out.selections.purposes.length, 2);
    // Concrete evidence.
    assert.equal(c.portal_user.evidence.email, 'te******@contoso.com');
    assert.equal(c.portal_user.evidence.owner.bound, true);
    assert.deepEqual(c.allowance_labels.evidence.scenarios[0].labels, ['$500', '$1000', '$1500']);
    assert.equal(c.allowance_labels.evidence.scenarios[0].chosen, '$1500');
    assert.deepEqual(c.field_ids.evidence.unchecked, []);
    assert.deepEqual(c.field_ids.evidence.slots.timezone, { expectedId: 'desitsm_timezonelist', id: 'desitsm_timezonelist', label: 'Time Zone', canonical: 'Time Zone', tier: 'id', pass: true, scenarios: c.field_ids.evidence.slots.timezone.scenarios });
    assert.equal(c.field_ids.evidence.slots.tenantName.pass, true);
    assert.deepEqual(c.validators.evidence.slots.owner.controls, ['desitsm_subscriptionowner']);
    assert.deepEqual(c.validators.evidence.slots.allowance.controls.sort(), ['desitsm_estimatedmonthlyspend', 'desitsm_monthlyspend'], 'live: Required on the select, Range on the carrier');
    assert.equal(c.validators.evidence.slots.allowance.proof.ok, true);
    assert.equal(c.timezone_default.evidence.scenarios[0].matched.value, 'tz-pst');
    assert.equal(c.timezone_default.evidence.scenarios[0].source, 'MCAPS_TIMEZONE');
    assert.equal(c.writes_blocked.evidence.portalAllowedOutsideSignIn, 0);
    assert.deepEqual(c.writes_blocked.evidence.allowed, { POST: { auth: 1 } });
    // Nothing identifying, nothing written, no state saved.
    assert.ok(!JSON.stringify(r.out).includes('testuser@'), 'the identity is always masked');
    assert.deepEqual(m.state.writes.map((w) => w.path), [SIGN_IN]);
    assert.equal(m.state.submissions.length, 0);
    for (const d of ['plans', 'locks']) assert.deepEqual(existsSync(join(home, d)) ? readdirSync(join(home, d)) : [], [], `${d} stays empty`);
    assert.equal(existsSync(join(home, 'profile.json')), false, 'no profile.json');
  }));

  it('a scoped run leaves the other type unchecked (null, exit 2), never a pass', () => withMock({}, async ({ verify }) => {
    const r = await verify(...SCOPED);
    const c = byId(r.out);
    assert.equal(r.code, 2);
    assert.equal(r.out.ok, false);
    assert.equal(c.field_ids.pass, null);
    assert.deepEqual(c.field_ids.evidence.unchecked.sort(), ['tenantLicensing', 'tenantName', 'tenantType']);
    assert.equal(c.validators.pass, null);
    for (const id of ['portal_user', 'allowance_labels', 'timezone_default', 'writes_blocked']) assert.equal(c[id].pass, true, `${id}: ${c[id].detail}`);
    assert.match(r.out.next, /null/);
  }));

  it('--purpose alone still cannot pass: other purposes were never exercised', () => withMock({}, async ({ verify }) => {
    const r = await verify('--purpose', 'Hybrid');
    const c = byId(r.out);
    assert.equal(r.code, 2, JSON.stringify(r.out.checks.map((x) => [x.id, x.pass])));
    assert.deepEqual(r.out.selections.types, ['internal', 'external']);
    assert.equal(c.field_ids.pass, null);
    assert.equal(c.validators.pass, null);
    assert.match(c.field_ids.detail, /--purpose/);
  }));

  it('A1: no Portal.User fails portal_user; userName alone passes', () => withMock({ portalUser: null }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).portal_user;
    assert.equal(c.pass, false, c.detail);
    assert.equal(c.evidence.present, false);
    assert.equal(c.evidence.owner.bound, false);
  }).then(() => withMock({ portalUser: { contactId: DEFAULTS.me.contactId, userName: DEFAULTS.me.upn } }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).portal_user;
    assert.equal(c.pass, true, c.detail);
    assert.equal(c.evidence.used, 'userName');
    assert.equal(c.evidence.email, null);
  })));

  it('A1 (live F1): active_request naming the user clears the owner in one type: unobservable there, pass on the other', () => withMock({ activeOwnersByType: { 444350000: [DEFAULTS.me.upn] } }, async ({ m, verify }) => {
    const r = await verify('--purpose', 'Hybrid');
    const c = byId(r.out).portal_user;
    assert.equal(c.pass, true, c.detail);
    const rows = Object.fromEntries(c.evidence.scenarios.map((x) => [x.scenario.split('/').pop(), x]));
    assert.equal(rows.internal.unobservable, 'active_request');
    assert.equal(rows.internal.pass, null);
    assert.equal(rows.external.pass, true);
    assert.equal(rows.external.unobservable, undefined);
    assert.match(c.detail, /unobservable/);
    assert.ok(r.out.scenarios.find((x) => x.name.endsWith('/internal')).blockers.includes('active_request'), 'the rule stays a blocker for the scenario');
    assert.equal(nonSignInWrites(m).length, 0);
  }).then(() => withMock({ activeOwnersByType: { 444350000: [DEFAULTS.me.upn], 444350001: [DEFAULTS.me.upn] } }, async ({ verify }) => {
    const c = byId((await verify('--purpose', 'Hybrid')).out).portal_user;
    assert.equal(c.pass, null, c.detail);
    assert.ok(c.evidence.scenarios.every((x) => x.unobservable === 'active_request'));
  })));

  it('A1: the owner blocker does not make a plan ready (active_request stays a blocker outside verify)', () => withMock({ activeOwnersByType: { 444350000: [DEFAULTS.me.upn] } }, async ({ m, home }) => {
    const env = { ...process.env, MCAPS_PORTAL_URL: m.formUrl, MCAPS_SKILL_HOME: home, MCAPS_LOG_FILE: join(home, 'run.log'), MCAPS_EPHEMERAL: '1', MCAPS_TIMEZONE: 'America/Los_Angeles' };
    delete env.MCAPS_PROFILE_DIR;
    const p = await run(['plan', '--purpose', 'Hybrid', '--type', 'internal'], { env });
    assert.equal(p.out.status, 'blocked', JSON.stringify(p.out));
    assert.ok(p.out.blockers.some((b) => b.code === 'active_request'));
    assert.equal(p.out.planId, undefined);
  }));

  it('A2: an unparsable allowance label fails; so does a tied maximum', () => withMock({ monthly: ['500', '1000', ['9999', 'Unlimited']] }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).allowance_labels;
    assert.equal(c.pass, false, c.detail);
    assert.deepEqual(c.evidence.scenarios[0].labels, ['$500', '$1000', 'Unlimited']);
    assert.deepEqual(c.evidence.scenarios[0].amounts, [500, 1000, null]);
    assert.match(c.detail, /Unlimited/);
  }).then(() => withMock({ monthly: ['500', ['1500a', '$1,500'], '1500'] }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).allowance_labels;
    assert.equal(c.pass, false, c.detail);
    assert.equal(c.evidence.scenarios[0].max, 1500);
    assert.equal(c.evidence.scenarios[0].maxCount, 2);
    assert.equal(c.evidence.scenarios[0].chosen, null);
  })));

  it('A3: a renamed control and a relabelled control each fail field_ids', () => withMock({ drift: { rename: { desitsm_timezonelist: 'desitsm_tz_v2' } } }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).field_ids;
    assert.equal(c.pass, false, c.detail);
    const t = c.evidence.slots.timezone;
    assert.equal(t.expectedId, 'desitsm_timezonelist');
    assert.equal(t.id, 'desitsm_tz_v2');
    assert.notEqual(t.tier, 'id');
    assert.equal(t.pass, false);
  }).then(() => withMock({ drift: { relabel: { desitsm_timezonelist: 'Local Time' } } }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).field_ids;
    assert.equal(c.pass, false, c.detail);
    const t = c.evidence.slots.timezone;
    assert.equal(t.tier, 'field_drift');
    assert.equal(t.label, 'Local Time');
    assert.equal(t.canonical, 'Time Zone');
  })));

  it('A4: a missing validator and one pointing elsewhere each fail validators', () => withMock({ drift: { noValidator: ['desitsm_timezonelist'] } }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).validators;
    assert.equal(c.pass, false, c.detail);
    assert.deepEqual(c.evidence.slots.timezone.messages, []);
    assert.equal(c.evidence.slots.timezone.proof.ok, false);
    assert.equal(c.evidence.slots.allowance.pass, true);
  }).then(() => withMock({ drift: { validatorControl: { desitsm_timezonelist: 'desitsm_monthlyspend' } } }, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).validators;
    assert.equal(c.pass, false, c.detail);
    assert.deepEqual(c.evidence.slots.timezone.controls, ['desitsm_monthlyspend']);
    assert.equal(c.evidence.slots.timezone.proof.ok, false);
  })));

  it('A5: a default zone that matches no option fails timezone_default', () => withMock({}, async ({ verify }) => {
    const c = byId((await verify(...SCOPED)).out).timezone_default;
    assert.equal(c.pass, false, c.detail);
    assert.equal(c.evidence.scenarios[0].zone, 'Asia/Tokyo');
    assert.equal(c.evidence.scenarios[0].matched, null);
    assert.equal(c.evidence.scenarios[0].offset, '+09:00');
  }, { env: { MCAPS_TIMEZONE: 'Asia/Tokyo' } }));

  it('A6: page writes of every method while filling are blocked, and verify never posts even with clickTamper', () => withMock({ drift: { fillWrites: true, clickTamper: { name: 'desitsm_treeview', value: 'CEO==>Someone Else' } } }, async ({ m, verify }) => {
    const r = await verify(...SCOPED);
    const c = byId(r.out).writes_blocked;
    assert.equal(c.pass, true, c.detail);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(c.evidence.blocked[method] >= 1, `${method} blocked: ${JSON.stringify(c.evidence.blocked)}`);
    assert.equal(c.evidence.portalAllowedOutsideSignIn, 0);
    assert.ok(c.evidence.witness.blockedByClient >= 4, JSON.stringify(c.evidence.witness));
    assert.deepEqual(c.evidence.violations, []);
    assert.deepEqual(nonSignInWrites(m), [], 'no write reached the portal');
    assert.equal(m.state.submissions.length, 0);
  }));
});
