// End-to-end tests: the real CLI driving a real headless Chromium/Edge against the hostile mock portal.
// Skipped automatically when no Chromium-family browser is installed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockPortal, DEFAULTS } from './fixtures/mock-portal.mjs';
import { run } from '../../skills/request-new-azure-subscription/scripts/mcaps-subscription.mjs';
import { findBrowser } from '../../skills/request-new-azure-subscription/scripts/lib/browser.mjs';
import { profileInUse } from '../../skills/request-new-azure-subscription/scripts/lib/cleanup.mjs';

let skip = false;
try { findBrowser(); } catch { skip = 'no Chromium-family browser found'; }

if (process.env.MCAPS_LAG_PROBE) {
  let last = performance.now();
  setInterval(() => { const now = performance.now(); if (now - last > 1500) console.error(`EVENT LOOP BLOCKED ${Math.round(now - last - 250)}ms at ${new Date().toISOString()}`); last = now; }, 250).unref();
}

const BASE = ['--purpose', 'Hybrid', '--type', 'internal', '--owner', 'testuser@contoso.com', '--allowance', '500', '--timezone', 'America/Los_Angeles'];

// Scenarios use throwaway profiles (deterministic, no lock waits) unless they opt into the persistent default.
async function scenario({ persistent = false, ...overrides } = {}) {
  const m = await startMockPortal({ users: structuredClone(DEFAULTS.users), ...overrides });
  const home = mkdtempSync(join(tmpdir(), 'mcaps-it-'));
  const env = { ...process.env, MCAPS_PORTAL_URL: m.formUrl, MCAPS_SKILL_HOME: home, MCAPS_LOG_FILE: join(home, 'run.log') };
  delete env.MCAPS_EPHEMERAL; delete env.MCAPS_PROFILE_DIR;
  if (!persistent) env.MCAPS_EPHEMERAL = '1';
  env.MCAPS_TIMEZONE = 'America/Los_Angeles';
  const cli = (...args) => run(args, { env });
  const formPosts = () => m.state.writes.filter((w) => w.path.startsWith('/support/eslabs-newazuresubscription')).length;
  return { m, cli, env, formPosts, home, async done() {
    await m.close();
    // Async rm: rmSync's retries sleep synchronously and would stall the concurrently running scenario.
    // The persistent profile can stay locked while Edge is reaped; the OS temp cleanup covers leftovers.
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
  } };
}

async function with_(overrides, fn) {
  const sc = await scenario(overrides);
  try { await fn(sc); } catch (e) {
    try { e.message += `\n--- driver log ---\n${readFileSync(join(sc.home, 'run.log'), 'utf8').split('\n').slice(-40).join('\n')}`; } catch {}
    throw e;
  } finally { await sc.done(); }
}

const plan = (sc, title = 'IT lab', extra = []) => sc.cli('plan', '--title', title, ...BASE, ...extra);
const submit = (sc, p, sha = p.out.terms?.sha, extra = []) => {
  assert.equal(p.out.status, 'ready', `plan was not ready: ${JSON.stringify(p.out)}`);
  return sc.cli('submit', '--plan', p.out.planId, '--accept-terms', sha, ...extra);
};

describe('mcaps-subscription CLI against the mock portal', { skip, concurrency: 2, timeout: 600000 }, () => {
  it('plan resolves every field, reads terms and never posts the form', () => with_({}, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.status, 'ready');
    assert.match(r.out.planId, /^[0-9a-f]{16}$/);
    assert.equal(r.out.resolved.purpose.label, 'Hybrid (Self-Learning/Demo)');
    assert.equal(r.out.resolved.timezone.value, 'tz-pst');
    assert.equal(r.out.derived.manager, 'Manager One');
    assert.match(r.out.terms.sha, /^[0-9a-f]{64}$/);
    assert.match(r.out.terms.text, /customer data/);
    assert.equal(sc.formPosts(), 0);
    assert.deepEqual(sc.m.state.writes.map((w) => w.path), ['/Account/Login/ExternalLogin']);
  }));

  it('reuses the persistent profile so later runs skip sign-in', (t) => with_({ persistent: true }, async (sc) => {
    const first = await plan(sc);
    assert.equal(first.out.profile, 'persistent');
    assert.ok(first.out.phases.signInClicked, 'first run signs in');
    const profile = join(sc.home, 'profile');
    // On EDR-managed Windows machines a closed browser can hold its profile lock for a minute or more.
    for (let i = 0; i < 600 && profileInUse(profile); i++) await new Promise((r) => setTimeout(r, 200));
    if (profileInUse(profile)) return t.skip('previous browser still holds the profile lock (slow OS process teardown)');
    const second = await plan(sc);
    assert.equal(second.out.status, 'ready');
    assert.equal(second.out.profile, 'persistent');
    assert.equal(second.out.phases.signInClicked, undefined, JSON.stringify(second.out.phases));
    const eph = await sc.cli('plan', '--title', 'IT lab', ...BASE, '--ephemeral');
    assert.equal(eph.out.profile, 'throwaway');
    assert.ok(eph.out.phases.signInClicked);
  }));

  it('reports missing inputs with the current option lists', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', '--title', 'Only a title');
    assert.equal(r.code, 2);
    assert.equal(r.out.status, 'needs_input');
    const purpose = r.out.missing.find((x) => x.field === 'purpose');
    assert.ok(purpose.options.includes('Hybrid (Self-Learning/Demo)'));
    assert.equal(r.out.planId, undefined);
  }));

  it('defaults internal type, highest allowance, self as owner, local time zone and a title', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', '--purpose', 'Hybrid');
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.match(r.out.resolved.type.label, /^Internal/);
    assert.equal(r.out.resolved.allowance.value, '1500');
    assert.equal(r.out.resolved.owner.upn, 'testuser@contoso.com');
    assert.equal(r.out.resolved.timezone.value, 'tz-pst');
    assert.match(r.out.resolved.title.value, /^testuser Azure subscription \d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(r.out.defaulted.map((d) => d.field).sort(), ['allowance', 'owner', 'timezone', 'title', 'type']);
    assert.ok(r.out.defaulted.every((d) => d.value && d.reason), JSON.stringify(r.out.defaulted));
    // Submit replays the planned values: nothing is re-defaulted (a changed zone cannot alter the request).
    sc.env.MCAPS_TIMEZONE = 'America/New_York';
    const s = await submit(sc, r);
    assert.equal(s.out.outcome, 'success', JSON.stringify(s.out));
    assert.equal(sc.m.state.submissions[0].desitsm_monthlyspend, '1500');
    assert.equal(sc.m.state.submissions[0].desitsm_timezonelist, 'tz-pst');
  }));

  it('defaults the purpose only when the portal offers exactly one; unmatched zones stay missing', () => with_({ purposes: [['444350001', 'Hybrid (Self-Learning/Demo)']] }, async (sc) => {
    sc.env.MCAPS_TIMEZONE = 'Asia/Tokyo';
    const r = await sc.cli('plan');
    assert.equal(r.out.status, 'needs_input', JSON.stringify(r.out));
    assert.equal(r.out.resolved.purpose.label, 'Hybrid (Self-Learning/Demo)');
    assert.deepEqual(r.out.missing.map((x) => x.field), ['timezone']);
    assert.equal(r.out.errors.length, 0, JSON.stringify(r.out.errors));
    assert.ok(!r.out.defaulted.some((d) => d.field === 'timezone'));
  }));

  it('never defaults the type over tenant values the user gave: asks for the type instead', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', '--purpose', 'Hybrid', '--tenant-name', 'Contoso Lab');
    assert.equal(r.out.status, 'needs_input', JSON.stringify(r.out));
    const m = r.out.missing.find((x) => x.field === 'type');
    assert.ok(m, JSON.stringify(r.out.missing));
    assert.ok(m.options?.length >= 2, JSON.stringify(m));
    assert.ok(!r.out.defaulted.some((d) => d.field === 'type'));
    assert.equal(r.out.planId, undefined);
  }));

  it('--no-defaults asks for every value', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', '--purpose', 'Hybrid', '--no-defaults');
    assert.equal(r.out.status, 'needs_input');
    for (const f of ['owner', 'type', 'title']) assert.ok(r.out.missing.some((x) => x.field === f), f);
    assert.deepEqual(r.out.defaulted, []);
  }));

  it('refuses ambiguous option matches instead of guessing', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', '--title', 'x', ...BASE.slice(0, -1), 'UTC-08:00');
    assert.equal(r.out.status, 'invalid');
    const e = r.out.errors.find((x) => x.field === 'timezone');
    assert.equal(e.code, 'ambiguous_option');
    assert.equal(e.candidates.length, 2);
  }));

  it('surfaces ambiguous and unknown owners with candidates', () => with_({ users: [...structuredClone(DEFAULTS.users), { display: 'Other Person', upn: 'other2@contoso.com', guid: '44444444-4444-4444-8444-444444444444', manager: { display: 'Manager Two', upn: 'mgr2@contoso.com' } }] }, async (sc) => {
    const amb = await sc.cli('plan', '--title', 'x', '--purpose', 'Hybrid', '--type', 'internal', '--owner', 'Other Person');
    const e = amb.out.errors.find((x) => x.field === 'owner');
    assert.equal(e.code, 'ambiguous_owner', JSON.stringify(amb.out.errors));
    assert.ok(e.candidates.length >= 2);
    const partial = await sc.cli('plan', '--title', 'x', '--purpose', 'Hybrid', '--type', 'internal', '--owner', 'Other P');
    const pe = partial.out.errors.find((x) => x.field === 'owner');
    assert.equal(pe.code, 'owner_not_found');
    assert.ok(pe.candidates.length >= 2, 'near matches are offered, never auto-picked');
    const none = await sc.cli('plan', '--title', 'x', '--purpose', 'Hybrid', '--type', 'internal', '--owner', 'nobody@contoso.com');
    assert.equal(none.out.errors.find((x) => x.field === 'owner').code, 'owner_not_found');
  }));

  it('blocks when the owner already has an active request', () => with_({ activeOwners: ['testuser@contoso.com'] }, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.code, 2);
    assert.equal(r.out.status, 'blocked');
    assert.ok(r.out.blockers.some((b) => b.code === 'active_request'), JSON.stringify(r.out.blockers));
    assert.equal(sc.formPosts(), 0);
  }));

  it('handles External subscriptions with tenant fields and the portal note', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', '--title', 'Ext lab', '--purpose', 'Hybrid', '--type', 'external', '--owner', 'testuser@contoso.com', '--allowance', '500',
      '--timezone', 'Eastern', '--tenant-type', 'User Tenant', '--tenant-licensing', 'M365 E5', '--tenant-name', 'Contoso Lab');
    assert.equal(r.out.status, 'ready', JSON.stringify({ m: r.out.missing, e: r.out.errors, b: r.out.blockers }));
    assert.equal(r.out.resolved.tenantType.label, 'Managed Environment - User Tenant');
    assert.ok(r.out.warnings.some((w) => w.code === 'portal_note'));
  }));

  it('detects new required fields (form drift) instead of submitting blind', () => with_({ drift: { extraRequired: { id: 'desitsm_costcenter', label: 'Cost Center' } } }, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.out.status, 'needs_input', JSON.stringify(r.out));
    assert.ok(r.out.missing.some((x) => x.code === 'unknown_required_field' && x.id === 'desitsm_costcenter'));
    const ok = await plan(sc, 'IT lab', ['--field', 'desitsm_costcenter=Yes']);
    assert.equal(ok.out.status, 'ready', JSON.stringify(ok.out.errors));
  }));

  it('blocks when the portal access check fails', () => with_({ mcaps: false }, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.out.status, 'blocked');
    assert.ok(r.out.blockers.some((b) => b.code === 'mcaps_access'));
  }));

  it('overlaps the slow VPN check with filling and still waits for it before finishing', () => with_({ vpnDelayMs: 4000 }, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.ok(r.out.phases.formQuiet - r.out.phases.formReady < 2500, `formQuiet waited on the background check: ${JSON.stringify(r.out.phases)}`);
    assert.ok(r.out.timings.background >= r.out.timings.purpose, JSON.stringify(r.out.timings));
  }));

  it('waits for portal init to re-add the allowed purposes (quiet network gap) before filling', () => with_({ purposeDelayMs: 2500 }, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out.errors));
    assert.equal(r.out.resolved.purpose.value, '444350001');
  }));

  it('never offers purposes the portal stripped', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', '--title', 'x', '--purpose', 'Customer Project');
    assert.equal(r.out.status, 'invalid');
    assert.equal(r.out.errors.find((e) => e.field === 'purpose').code, 'invalid_option');
  }));

  it('stops quickly with no_eligible_purpose when the portal offers none', () => with_({ purposes: [] }, async (sc) => {
    const t = Date.now();
    const r = await plan(sc);
    assert.equal(r.out.error, 'no_eligible_purpose', JSON.stringify(r.out));
    assert.match(r.out.message, /no subscription purpose/i);
    assert.ok(Date.now() - t < 30000);
  }));

  it('reports portal_unreachable quickly when the portal never answers', () => with_({ hangPages: true }, async (sc) => {
    const t = performance.now();
    const r = await sc.cli('plan', '--title', 'IT lab', ...BASE);
    assert.equal(r.code, 1);
    assert.equal(r.out.error, 'portal_unreachable', JSON.stringify(r.out));
    assert.match(r.out.message, /VPN|network/i);
    assert.ok(performance.now() - t < 30000);
  }));

  it('reports portal_unreachable when the connection is refused', () => with_({}, async (sc) => {
    const srv = createNetServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    const env = { ...process.env, MCAPS_PORTAL_URL: `http://127.0.0.1:${port}/support/eslabs-newazuresubscription/?ServiceId=x`, MCAPS_SKILL_HOME: sc.home, MCAPS_EPHEMERAL: '1' };
    const r = await run(['plan', '--title', 'IT lab', ...BASE], { env });
    assert.equal(r.code, 1);
    assert.equal(r.out.error, 'portal_unreachable', JSON.stringify(r.out));
  }));

  it('stops with vpn_required when the portal VPN check fails', () => with_({ vpnFail: true, vpnDelayMs: 0 }, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.code, 1);
    assert.equal(r.out.error, 'vpn_required', JSON.stringify(r.out));
    assert.ok(r.out.message.length > 0);
    assert.equal(sc.formPosts(), 0);
  }));

  it('stops with vpn_required when the VPN check fails after filling started', () => with_({ vpnFail: true, vpnDelayMs: 2500 }, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.out.error, 'vpn_required', JSON.stringify(r.out));
  }));

  it('submits exactly once and refuses a second submit of the same request', () => with_({ persistent: true }, async (sc) => {
    const p = await plan(sc);
    const s = await submit(sc, p);
    assert.equal(s.code, 0, JSON.stringify(s.out));
    assert.equal(s.out.outcome, 'success');
    assert.match(s.out.caseId, /^REQ-\d{6}-2026$/);
    assert.equal(sc.m.state.submissions.length, 1);
    const sub = sc.m.state.submissions[0];
    assert.equal(sub.apitil_title, 'IT lab');
    assert.equal(sub.desitsm_agreetothetermsandconditions, 'on');
    assert.equal(sub.itserv_businessmanageruserid, '11111111-1111-4111-8111-111111111111');
    const again = await submit(sc, p);
    assert.equal(again.out.error, 'already_submitted');
    assert.equal(again.out.previous.caseId, s.out.caseId);
    assert.equal(sc.m.state.submissions.length, 1);
    const st = await sc.cli('status');
    assert.ok(st.out.requests.some((x) => x.caseId === s.out.caseId), JSON.stringify(st.out));
    const one = await sc.cli('status', '--case', s.out.caseId);
    assert.equal(one.out.requests.length, 1);
  }));

  it('requires the exact terms sha shown in the plan', () => with_({}, async (sc) => {
    const p = await plan(sc);
    const r = await submit(sc, p, 'deadbeef');
    assert.equal(r.out.error, 'terms_not_accepted');
    assert.equal(sc.m.state.submissions.length, 0);
  }));

  it('refuses to submit when the terms changed after planning', () => with_({}, async (sc) => {
    const p = await plan(sc);
    sc.m.state.config.termsText = 'Updated terms: new obligations apply.';
    const r = await submit(sc, p);
    assert.equal(r.out.outcome, 'not_submitted');
    assert.equal(r.out.reason, 'plan_mismatch');
    assert.ok(r.out.changes.some((c) => c.path === 'terms'));
    assert.equal(sc.m.state.submissions.length, 0);
  }));

  it('refuses to submit when derived values changed after planning', () => with_({}, async (sc) => {
    const p = await plan(sc);
    sc.m.state.config.users[0].manager = { display: 'New Manager', upn: 'newmgr@contoso.com' };
    const r = await submit(sc, p);
    assert.equal(r.out.reason, 'plan_mismatch');
    assert.ok(r.out.changes.some((c) => c.path === 'derived.manager' && c.now === 'New Manager'));
    assert.equal(sc.m.state.submissions.length, 0);
  }));

  for (const mode of ['error500', 'drop']) {
    it(`reconciles the case via the API when the response is lost (${mode})`, () => with_({ submitMode: mode }, async (sc) => {
      const p = await plan(sc);
      const s = await submit(sc, p);
      assert.equal(s.out.outcome, 'success', JSON.stringify(s.out));
      assert.equal(s.out.caseId, sc.m.state.records[0].apitil_requestnumber);
      assert.equal(sc.m.state.submissions.length, 1);
    }));
  }

  it('reports unknown (never retries) when the outcome cannot be proven', () => with_({ submitMode: 'drop-norecord' }, async (sc) => {
    const p = await plan(sc);
    const s = await submit(sc, p);
    assert.equal(s.code, 3, JSON.stringify(s.out));
    assert.equal(s.out.outcome, 'unknown');
    assert.equal(sc.m.state.submissions.length, 1);
    sc.m.state.config.submitMode = 'success';
    const again = await submit(sc, p);
    assert.equal(again.out.error, 'already_submitted');
    assert.equal(sc.m.state.submissions.length, 1);
  }));

  it('allows a deliberate retry only after a provable server rejection', () => with_({ submitMode: 'reject' }, async (sc) => {
    const p = await plan(sc);
    const s = await submit(sc, p);
    assert.equal(s.out.outcome, 'rejected', JSON.stringify(s.out));
    assert.equal(s.code, 2);
    assert.ok(s.out.errors.some((e) => /Owner is invalid/.test(e.message)), JSON.stringify(s.out.errors));
    sc.m.state.config.submitMode = 'success';
    const retry = await submit(sc, p);
    assert.equal(retry.out.outcome, 'success', JSON.stringify(retry.out));
    assert.equal(sc.m.state.submissions.length, 2);
  }));

  it('a re-rendered form is not a rejection unless the API proves nothing was created', () => with_({ submitMode: 'reject', apiFailAfterPost: true }, async (sc) => {
    const p = await plan(sc);
    const s = await submit(sc, p);
    assert.equal(s.out.outcome, 'unknown', JSON.stringify(s.out));
    assert.equal(s.code, 3);
    const again = await submit(sc, p);
    assert.equal(again.out.error, 'already_submitted');
    assert.equal(sc.m.state.submissions.length, 1);
  }));

  it('a case id seen only on the confirmation page is unknown, not success', () => with_({ hideCreated: true }, async (sc) => {
    const p = await plan(sc);
    const s = await submit(sc, p);
    assert.equal(s.out.outcome, 'unknown', JSON.stringify(s.out));
    assert.equal(s.out.probableCaseId, sc.m.state.records[0].apitil_requestnumber);
    assert.equal(s.out.caseId, undefined);
    assert.equal((await submit(sc, p)).out.error, 'already_submitted');
    assert.equal(sc.m.state.submissions.length, 1);
  }));

  it('blocks the POST when page script changes a verified value at submit time', () => with_({ tamperOwner: '22222222-2222-4222-8222-222222222222' }, async (sc) => {
    const p = await plan(sc);
    const s = await submit(sc, p);
    assert.equal(s.out.outcome, 'not_submitted', JSON.stringify(s.out));
    assert.equal(s.out.reason, 'submit_body_mismatch');
    assert.ok(s.out.fields.includes('itserv_businessmanageruserid'), JSON.stringify(s.out.fields));
    assert.equal(sc.m.state.submissions.length, 0);
    sc.m.state.config.tamperOwner = null;
    const retry = await submit(sc, p);
    assert.equal(retry.out.outcome, 'success', JSON.stringify(retry.out));
    assert.equal(sc.m.state.submissions[0].itserv_businessmanageruserid, '11111111-1111-4111-8111-111111111111');
  }));

  it('rejects an edited plan file and never prints the terms sha as a ready-made command', () => with_({}, async (sc) => {
    const p = await plan(sc);
    assert.ok(!p.out.next.includes(p.out.terms.sha), p.out.next);
    const file = join(sc.home, 'plans', `${p.out.planId}.json`);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.input.title = 'edited'; saved.material.input.title = 'edited';
    writeFileSync(file, JSON.stringify(saved));
    const r = await submit(sc, p);
    assert.equal(r.out.error, 'plan_invalid', JSON.stringify(r.out));
    assert.equal(sc.m.state.submissions.length, 0);
  }));

  it('--allow-duplicate can deliberately repeat a request that succeeded', () => with_({}, async (sc) => {
    const p = await plan(sc);
    const first = await submit(sc, p);
    assert.equal(first.out.outcome, 'success', JSON.stringify(first.out));
    const refused = await submit(sc, p);
    assert.equal(refused.out.error, 'already_submitted');
    const second = await submit(sc, p, p.out.terms.sha, ['--allow-duplicate']);
    assert.equal(second.out.outcome, 'success', JSON.stringify(second.out));
    assert.notEqual(second.out.caseId, first.out.caseId);
    assert.equal(sc.m.state.submissions.length, 2);
  }));

  it('status --case queries the server (older cases too) and reports not found', () => with_({
    records: Array.from({ length: 12 }, (_, i) => ({ apitil_servicerequestid: `r${i}`, apitil_requestnumber: `REQ-1000${String(i).padStart(2, '0')}-2026`, apitil_name: `REQ-1000${String(i).padStart(2, '0')}-2026 - Lab ${i}`, statuscode: 1, statecode: 0, createdon: new Date(Date.now() - i * 3600e3).toISOString(), _apitil_contact_value: DEFAULTS.me.contactId })),
  }, async (sc) => {
    const old = await sc.cli('status', '--case', 'REQ-100011-2026');
    assert.equal(old.code, 0, JSON.stringify(old.out));
    assert.equal(old.out.found, true);
    assert.equal(old.out.requests[0].caseId, 'REQ-100011-2026');
    const none = await sc.cli('status', '--case', 'REQ-999999-2026');
    assert.equal(none.code, 2);
    assert.equal(none.out.found, false);
  }));

  it('warns in plan and refuses in submit when an active request with the same title exists', () => with_({
    records: [{ apitil_servicerequestid: 'r1', apitil_requestnumber: 'REQ-100001-2026', apitil_name: 'REQ-100001-2026 - IT lab', statuscode: 345550000, 'statuscode@OData.Community.Display.V1.FormattedValue': 'Awaiting Approval', statecode: 0, createdon: new Date().toISOString(), _apitil_contact_value: DEFAULTS.me.contactId }],
  }, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'ready');
    assert.ok(p.out.warnings.some((w) => w.code === 'possible_duplicate' && w.requests[0].caseId === 'REQ-100001-2026'), JSON.stringify(p.out.warnings));
    const s = await submit(sc, p);
    assert.equal(s.out.reason, 'duplicate_active');
    assert.equal(sc.m.state.submissions.length, 0);
    const forced = await submit(sc, p, p.out.terms.sha, ['--allow-duplicate']);
    assert.equal(forced.out.outcome, 'success', JSON.stringify(forced.out));
    assert.notEqual(forced.out.caseId, 'REQ-100001-2026');
  }));
});

describe('form drift: resolve renamed/relabeled controls without weakening the POST binding', { skip, concurrency: 2, timeout: 600000 }, () => {
  const remapped = (out, field) => out.warnings.find((w) => w.code === 'field_remapped' && w.field === field);

  it('heals pure renames (timezone, allowance) and posts under the new names', () => with_({ drift: { rename: { desitsm_timezonelist: 'desitsm_tz_v2', desitsm_monthlyspend: 'desitsm_allowance_v2' } } }, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'ready', JSON.stringify(p.out));
    assert.deepEqual(remapped(p.out, 'timezone'), { code: 'field_remapped', field: 'timezone', expectedId: 'desitsm_timezonelist', id: 'desitsm_tz_v2', label: 'Time Zone', via: 'renamed' });
    assert.equal(remapped(p.out, 'allowance')?.id, 'desitsm_allowance_v2');
    assert.equal(p.out.resolved.timezone.value, 'tz-pst');
    const s = await submit(sc, p);
    assert.equal(s.out.outcome, 'success', JSON.stringify(s.out));
    const sub = sc.m.state.submissions[0];
    assert.equal(sub.desitsm_tz_v2, 'tz-pst');
    assert.equal(sub.desitsm_allowance_v2, '500');
    assert.equal(sub.desitsm_timezonelist, undefined);
  }));

  it('finds a renamed purpose select by its label (form readiness and resolution)', () => with_({ drift: { rename: { desitsm_subscriptionpurposeaz: 'desitsm_purpose_v2' } } }, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'ready', JSON.stringify(p.out));
    assert.equal(remapped(p.out, 'purpose')?.id, 'desitsm_purpose_v2');
    assert.equal(p.out.resolved.purpose.label, 'Hybrid (Self-Learning/Demo)');
  }));

  it('never guesses a relabeled control: field_drift with a suggestion, ready only with --map', () => with_({ drift: { relabel: { desitsm_timezonelist: 'Local Time' } } }, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'needs_input', JSON.stringify(p.out));
    assert.equal(p.out.resolved.timezone, undefined);
    const d = p.out.missing.find((m) => m.code === 'field_drift');
    assert.equal(d.field, 'timezone');
    assert.equal(d.expectedId, 'desitsm_timezonelist');
    assert.equal(d.suggested?.id, 'desitsm_timezonelist', JSON.stringify(d));
    assert.ok(!p.out.missing.some((m) => m.code === 'unknown_required_field'), JSON.stringify(p.out.missing));
    const ok = await plan(sc, 'IT lab', ['--map', 'timezone=desitsm_timezonelist']);
    assert.equal(ok.out.status, 'ready', JSON.stringify(ok.out));
    assert.equal(remapped(ok.out, 'timezone')?.via, 'mapped');
    assert.equal(ok.out.resolved.timezone.value, 'tz-pst');
    assert.notEqual(ok.out.planId, undefined);
  }));

  it('rejects a --map to a derived or foreign field before starting the browser', () => with_({}, async (sc) => {
    const r = await plan(sc, 'IT lab', ['--map', 'timezone=itserv_businessmanageruserid']);
    assert.equal(r.code, 1);
    assert.equal(r.out.error, 'invalid_mapping');
    const t = await plan(sc, 'IT lab', ['--map', 'timezone=apitil_title']);
    assert.equal(t.out.error, 'invalid_mapping', JSON.stringify(t.out));
    assert.equal(sc.m.state.requests, 0);
  }));

  it('refuses a --map that fails the live checks (option signature)', () => with_({ drift: { relabel: { desitsm_timezonelist: 'Local Time' }, extraRequired: { id: 'desitsm_costcenter', label: 'Cost Center' } } }, async (sc) => {
    const r = await plan(sc, 'IT lab', ['--map', 'timezone=desitsm_costcenter']);
    assert.equal(r.out.status, 'invalid', JSON.stringify(r.out));
    assert.ok(r.out.errors.some((e) => e.code === 'invalid_mapping' && e.field === 'timezone' && e.reason === 'signature'), JSON.stringify(r.out.errors));
    assert.equal(r.out.resolved.timezone, undefined);
  }));

  it('a rename between plan and submit is a plan_mismatch; nothing is sent', () => with_({}, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'ready');
    sc.m.state.config.drift = { rename: { desitsm_timezonelist: 'desitsm_tz_v2' } };
    const s = await submit(sc, p);
    assert.equal(s.out.reason, 'plan_mismatch', JSON.stringify(s.out));
    assert.ok(s.out.changes.some((c) => c.path.startsWith('fieldMap.timezone')), JSON.stringify(s.out.changes));
    assert.equal(sc.m.state.submissions.length, 0);
  }));

  it('a new default-populated business field after plan is a plan_mismatch', () => with_({}, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'ready');
    sc.m.state.config.drift = { extraPopulated: { id: 'desitsm_costcenter', value: 'CC-42' } };
    const s = await submit(sc, p);
    assert.equal(s.out.reason, 'plan_mismatch', JSON.stringify(s.out));
    assert.ok(s.out.changes.some((c) => c.path.startsWith('postNames')), JSON.stringify(s.out.changes));
    assert.equal(sc.m.state.submissions.length, 0);
  }));

  it('blocks the POST when a click-time script writes an unbound business field', () => with_({ drift: { clickTamper: { name: 'desitsm_treeview', value: 'CEO==>Someone Else' } } }, async (sc) => {
    const p = await plan(sc);
    const s = await submit(sc, p);
    assert.equal(s.out.outcome, 'not_submitted', JSON.stringify(s.out));
    assert.equal(s.out.reason, 'submit_body_mismatch');
    assert.ok(s.out.fields.includes('desitsm_treeview'), JSON.stringify(s.out.fields));
    assert.equal(sc.m.state.submissions.length, 0);
  }));

  it('never heals the owner control', () => with_({ drift: { rename: { desitsm_subscriptionowner: 'desitsm_owner_v2' } } }, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'blocked', JSON.stringify(p.out));
    assert.ok(p.out.blockers.some((b) => b.code === 'form_drift' && b.field === 'owner' && b.expectedId === 'desitsm_subscriptionowner'), JSON.stringify(p.out.blockers));
    assert.equal(p.out.resolved.owner, undefined);
    assert.ok(!p.out.warnings.some((w) => w.code === 'field_remapped' && w.field === 'owner'));
  }));

  it('two controls with the slot label: drift, no suggestion', () => with_({ drift: { rename: { desitsm_timezonelist: 'desitsm_tzone' }, duplicateLabel: { of: 'desitsm_timezonelist', id: 'desitsm_tzdup' } } }, async (sc) => {
    const p = await plan(sc);
    assert.equal(p.out.status, 'needs_input', JSON.stringify(p.out));
    const d = p.out.missing.find((m) => m.code === 'field_drift' && m.field === 'timezone');
    assert.ok(d, JSON.stringify(p.out.missing));
    assert.equal(d.suggested, undefined);
    assert.deepEqual(d.candidates.map((c) => c.id).sort(), ['desitsm_tzdup', 'desitsm_tzone']);
  }));
});