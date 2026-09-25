// Pure checks behind `verify` (no browser). Each check must fail closed: a skipped scenario is null, never a pass.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_IDS, maskIdentity, labelAmount, standardOffset, checkPortalUser, checkAllowance, checkFieldIds, checkValidators, checkTimezone, checkWrites, verdict, narrowToScope } from '../../skills/request-new-azure-subscription/scripts/lib/verify.mjs';

const FORM = 'https://portal.example.com/support/eslabs-newazuresubscription/?ServiceId=abc';
const CANON = { title: 'Title', purpose: 'Subscription Purpose', type: 'Subscription Type', owner: 'Subscription Owner', allowance: 'Monthly Allowance', timezone: 'Time Zone', tenantType: 'Tenant Type', tenantLicensing: 'Tenant Licensing', tenantName: 'Tenant Display Name' };
const ID = { title: 'apitil_title', purpose: 'desitsm_subscriptionpurposeaz', type: 'desitsm_subscriptiontypes', owner: 'desitsm_subscriptionowner', allowance: 'desitsm_monthlyspend', timezone: 'desitsm_timezonelist', tenantType: 'desitsm_tenanttypes', tenantLicensing: 'desitsm_tenantlicensing', tenantName: 'desitsm_tenantdisplayname' };
const COMMON = ['title', 'purpose', 'type', 'owner'];
const DEP = { internal: ['allowance', 'timezone'], external: ['tenantType', 'tenantLicensing', 'tenantName'] };
const slot = (k, over = {}) => ({ expectedId: ID[k], id: ID[k], label: CANON[k], tier: 'id', count: 1, associated: true, ...over });
const MONEY = [{ value: '', label: '' }, { value: '500', label: '$500' }, { value: '1000', label: '$1,000' }, { value: '1500', label: '$1,500' }];
const ZONES = [{ value: '', label: 'Select' }, { value: 'tz-pst', label: '(UTC-08:00) Pacific Time (US & Canada)' }, { value: 'tz-baja', label: '(UTC-08:00) Baja California' }, { value: 'tz-est', label: '(UTC-05:00) Eastern Time (US & Canada)' }];

function scen(type, over = {}) {
  const applies = [...COMMON, ...DEP[type]];
  return {
    name: `Hybrid/${type}`, type, pageUrl: FORM,
    user: { present: true, email: 'testuser@contoso.com', userName: 'testuser@contoso.com' },
    applies,
    slots: Object.fromEntries(applies.map((k) => [k, slot(k)])),
    validators: [...COMMON, ...DEP.internal, ...DEP.external].map((k) => ({ control: ID[k], message: `${CANON[k]} is a required field.`, enabled: true })),
    owner: { reached: true, defaulted: true, upn: 'testuser@contoso.com', guid: true },
    allowance: type === 'internal' ? { id: ID.allowance, options: MONEY, selected: '1500', defaulted: true } : null,
    timezone: type === 'internal' ? { id: ID.timezone, options: ZONES, selected: 'tz-pst', defaulted: true, zone: 'America/Los_Angeles', source: 'MCAPS_TIMEZONE' } : null,
    ...over,
  };
}
const both = () => [scen('internal'), scen('external')];

describe('helpers', () => {
  it('masks the local part except its first 2 characters', () => {
    assert.equal(maskIdentity('testuser@contoso.com'), 'te******@contoso.com');
    assert.equal(maskIdentity('ab@contoso.com'), 'ab@contoso.com');
    assert.equal(maskIdentity('someone'), 'so*****');
    assert.equal(maskIdentity(null), null);
  });

  it('parses amounts from the label only, strictly', () => {
    assert.equal(labelAmount('$500'), 500);
    assert.equal(labelAmount('$1,500'), 1500);
    assert.equal(labelAmount('500 USD'), 500);
    assert.equal(labelAmount('$250.50 / month'), 250.5);
    for (const bad of ['Unlimited', '$500 - $1000', '', 'Up to 500', '5OO']) assert.equal(labelAmount(bad), null, bad);
  });

  it('computes the standard (non-DST) UTC offset of an IANA zone', () => {
    assert.equal(standardOffset('America/Los_Angeles'), '-08:00');
    assert.equal(standardOffset('Australia/Sydney'), '+10:00');
    assert.equal(standardOffset('Asia/Kolkata'), '+05:30');
    assert.equal(standardOffset('Etc/UTC'), '+00:00');
    assert.equal(standardOffset('Pacific Time'), null);
  });
});

describe('portal_user (A1)', () => {
  it('passes when the user is exposed and the owner default bound to them on the page', () => {
    const c = checkPortalUser(both());
    assert.equal(c.id, 'portal_user');
    assert.equal(c.pass, true, c.detail);
    assert.equal(c.evidence.email, 'te******@contoso.com');
    assert.equal(c.evidence.used, 'email');
    assert.equal(c.evidence.owner.bound, true);
    assert.ok(!JSON.stringify(c).includes('testuser'), 'never the full identity');
  });

  it('userName alone is enough', () => {
    const c = checkPortalUser([scen('internal', { user: { present: true, email: null, userName: 'testuser@contoso.com' } })]);
    assert.equal(c.pass, true, c.detail);
    assert.equal(c.evidence.used, 'userName');
  });

  it('fails when Portal.User exposes neither email nor userName', () => {
    const c = checkPortalUser([scen('internal', { user: { present: false, email: null, userName: null }, owner: { reached: true, defaulted: false, upn: null, guid: false } })]);
    assert.equal(c.pass, false);
    assert.equal(c.evidence.present, false);
  });

  it('fails when the page bound someone else, or bound nobody', () => {
    assert.equal(checkPortalUser([scen('internal', { owner: { reached: true, defaulted: true, upn: 'other@contoso.com', guid: true } })]).pass, false);
    assert.equal(checkPortalUser([scen('internal', { owner: { reached: true, defaulted: false, upn: null, guid: false } })]).pass, false);
    assert.equal(checkPortalUser([scen('internal', { owner: { reached: true, defaulted: true, upn: 'testuser@contoso.com', guid: false } })]).pass, false);
  });

  it('is null when the owner step never ran', () => {
    const c = checkPortalUser([scen('internal', { owner: { reached: false } })]);
    assert.equal(c.pass, null);
    assert.match(c.detail, /owner/);
  });
});

describe('allowance_labels (A2)', () => {
  it('passes with every label parsed, a unique maximum and that option selected by default', () => {
    const c = checkAllowance(both());
    assert.equal(c.pass, true, c.detail);
    const s = c.evidence.scenarios[0];
    assert.deepEqual(s.labels, ['$500', '$1,000', '$1,500']);
    assert.deepEqual(s.amounts, [500, 1000, 1500]);
    assert.equal(s.max, 1500);
    assert.equal(s.chosen, '$1,500');
  });

  it('fails on an unparsable label even when its value is a number', () => {
    const c = checkAllowance([scen('internal', { allowance: { id: ID.allowance, options: [...MONEY, { value: '9999', label: 'Unlimited' }], selected: '9999', defaulted: true } })]);
    assert.equal(c.pass, false);
    assert.deepEqual(c.evidence.scenarios[0].amounts, [500, 1000, 1500, null]);
  });

  it('fails on a tied maximum', () => {
    const c = checkAllowance([scen('internal', { allowance: { id: ID.allowance, options: [...MONEY, { value: '1500b', label: '$1500' }], selected: '', defaulted: false } })]);
    assert.equal(c.pass, false);
    assert.equal(c.evidence.scenarios[0].maxCount, 2);
    assert.equal(c.evidence.scenarios[0].chosen, null);
  });

  it('fails when the page does not hold the maximum after defaulting', () => {
    assert.equal(checkAllowance([scen('internal', { allowance: { id: ID.allowance, options: MONEY, selected: '500', defaulted: true } })]).pass, false);
    assert.equal(checkAllowance([scen('internal', { allowance: { id: ID.allowance, options: MONEY, selected: '1500', defaulted: false } })]).pass, false);
  });

  it('is null when no scenario showed the allowance', () => {
    assert.equal(checkAllowance([scen('external')]).pass, null);
  });
});

describe('field_ids (A3)', () => {
  it('passes when every slot of both types is at its expected id with its canonical label', () => {
    const c = checkFieldIds(both());
    assert.equal(c.pass, true, c.detail);
    assert.deepEqual(Object.keys(c.evidence.slots).sort(), Object.keys(ID).sort());
    assert.deepEqual(c.evidence.slots.timezone, { expectedId: ID.timezone, id: ID.timezone, label: 'Time Zone', canonical: 'Time Zone', tier: 'id', pass: true, scenarios: ['Hybrid/internal'] });
    assert.deepEqual(c.evidence.unchecked, []);
  });

  it('never trusts an id without its label', () => {
    const s = scen('internal');
    s.slots.purpose = slot('purpose', { label: 'Subscription Purpose (legacy)' });
    const c = checkFieldIds([s, scen('external')]);
    assert.equal(c.pass, false);
    assert.equal(c.evidence.slots.purpose.pass, false);
  });

  it('fails on a renamed or drifted control, a duplicate id or an unassociated label', () => {
    for (const bad of [{ id: 'desitsm_tz_v2', tier: 'renamed' }, { id: null, tier: 'field_drift', label: 'Local Time' }, { count: 2 }, { associated: false }]) {
      const s = scen('internal');
      s.slots.timezone = slot('timezone', bad);
      assert.equal(checkFieldIds([s, scen('external')]).pass, false, JSON.stringify(bad));
    }
  });

  it('a slot that failed in any scenario fails, even if another scenario passed it', () => {
    const s = scen('external');
    s.slots.title = slot('title', { tier: 'renamed', id: 'x_title' });
    const c = checkFieldIds([scen('internal'), s]);
    assert.equal(c.pass, false);
    assert.equal(c.evidence.slots.title.id, 'x_title');
  });

  it('is null (not a pass) when slots were never checked', () => {
    const c = checkFieldIds([scen('internal')]);
    assert.equal(c.pass, null);
    assert.deepEqual(c.evidence.unchecked.sort(), ['tenantLicensing', 'tenantName', 'tenantType']);
    const s = scen('internal');
    s.slots.timezone = slot('timezone', { tier: 'renamed', id: 'z' });
    assert.equal(checkFieldIds([s]).pass, false, 'a failure beats unchecked');
  });
});

describe('validators (A4)', () => {
  it('passes when each slot has an enabled validator naming its label on its expected id', () => {
    const c = checkValidators(both());
    assert.equal(c.pass, true, c.detail);
    const v = c.evidence.slots.timezone;
    assert.deepEqual(v.messages, ['Time Zone is a required field.']);
    assert.deepEqual(v.controls, [ID.timezone]);
    assert.equal(v.proof.ok, true);
    assert.ok(c.evidence.slots.owner, 'owner is checked too');
  });

  it('fails when the validator is missing, disabled or points elsewhere', () => {
    const drop = (list) => list.filter((v) => v.control !== ID.timezone);
    const cases = {
      missing: (list) => drop(list),
      disabled: (list) => list.map((v) => (v.control === ID.timezone ? { ...v, enabled: false } : v)),
      elsewhere: (list) => [...drop(list), { control: ID.allowance, message: 'Time Zone is a required field.', enabled: true }],
    };
    for (const [name, f] of Object.entries(cases)) {
      const s = scen('internal');
      s.validators = f(s.validators);
      const c = checkValidators([s, scen('external')]);
      assert.equal(c.pass, false, name);
      assert.equal(c.evidence.slots.timezone.pass, false, name);
      assert.equal(c.evidence.slots.timezone.proof.ok, false, name);
    }
  });

  it('is null when slots were never checked', () => {
    assert.equal(checkValidators([scen('internal')]).pass, null);
  });
});

describe('timezone_default (A5)', () => {
  it('passes when the zone matches exactly one option and the page selected it', () => {
    const c = checkTimezone(both());
    assert.equal(c.pass, true, c.detail);
    const s = c.evidence.scenarios[0];
    assert.equal(s.zone, 'America/Los_Angeles');
    assert.deepEqual(s.matched, { value: 'tz-pst', label: '(UTC-08:00) Pacific Time (US & Canada)' });
    assert.equal(s.offset, '-08:00');
    assert.equal(s.offsetAgrees, true);
  });

  it('fails on no match, several matches, a different selection or an offset that disagrees', () => {
    const tz = (over) => [scen('internal', { timezone: { id: ID.timezone, options: ZONES, selected: '', defaulted: false, zone: 'America/Los_Angeles', source: 'os', ...over } })];
    assert.equal(checkTimezone(tz({ zone: 'Asia/Tokyo' })).pass, false);
    const amb = checkTimezone(tz({ zone: 'UTC-08:00' }));
    assert.equal(amb.pass, false);
    assert.equal(amb.evidence.scenarios[0].candidates.length, 2);
    assert.equal(checkTimezone(tz({ selected: 'tz-baja', defaulted: true })).pass, false);
    assert.equal(checkTimezone(tz({ options: [{ value: 'x', label: '(UTC+01:00) Pacific Time (US & Canada)' }], selected: 'x', defaulted: true })).pass, false);
  });

  it('a label without an offset is judged by the unique match alone, and says so (offsetAgrees: null)', () => {
    const c = checkTimezone([scen('internal', { timezone: { id: ID.timezone, options: [{ value: '', label: 'Select' }, { value: 'c', label: 'Central Time (US & Canada)' }], selected: 'c', defaulted: true, zone: 'Central Time (US & Canada)', source: 'MCAPS_TIMEZONE' } })]);
    assert.equal(c.pass, true, c.detail);
    assert.equal(c.evidence.scenarios[0].offsetAgrees, null);
  });

  it('is null without a zone or without a scenario that shows the field', () => {
    assert.equal(checkTimezone([scen('external')]).pass, null);
    assert.equal(checkTimezone([scen('internal', { timezone: { id: ID.timezone, options: ZONES, selected: '', defaulted: false, zone: null, source: 'os' } })]).pass, null);
  });
});

describe('writes_blocked (A6)', () => {
  const w = (over) => ({ method: 'POST', host: 'portal.example.com', path: '/_api/x', portal: true, action: 'fail', reason: 'blocked-write', phase: 'fill', ref: 'a|1', ...over });
  const signIn = w({ path: '/Account/Login/ExternalLogin', action: 'continue', reason: 'auth', phase: 'load', ref: 'a|0' });
  const base = (over = {}) => ({
    fillReached: true, submitsSent: 0, everArmed: false,
    decisions: [signIn, w(), w({ method: 'PUT', ref: 'a|2' }), w({ method: 'POST', host: 'login.microsoftonline.com', path: '/common/x', portal: false, action: 'continue', reason: 'identity', ref: 'a|3' })],
    witness: [{ ref: 'a|0', method: 'POST', path: '/Account/Login/ExternalLogin', phase: 'load', responded: true, blocked: false }, { ref: 'a|1', method: 'POST', path: '/_api/x', phase: 'fill', responded: false, blocked: true }],
    ...over,
  });

  it('passes with sign-in allowed while loading and every fill-time portal write blocked', () => {
    const c = checkWrites(base());
    assert.equal(c.pass, true, c.detail);
    assert.deepEqual(c.evidence.blocked, { POST: 1, PUT: 1 });
    assert.deepEqual(c.evidence.allowed, { POST: { auth: 1, identity: 1 } });
    assert.equal(c.evidence.portalAllowedOutsideSignIn, 0);
    assert.equal(c.evidence.witness.responded, 1);
    assert.equal(c.evidence.witness.blockedByClient, 1);
    assert.deepEqual(c.evidence.violations, []);
  });

  it('fails on a portal write allowed during filling, even on a sign-in path', () => {
    const c = checkWrites(base({ decisions: [signIn, w({ path: '/', action: 'continue', reason: 'auth' })] }));
    assert.equal(c.pass, false);
    assert.equal(c.evidence.portalAllowedOutsideSignIn, 1);
  });

  it('fails on any submit, an armed gate, or a write the network saw answered although the guard blocked it', () => {
    assert.equal(checkWrites(base({ submitsSent: 1 })).pass, false);
    assert.equal(checkWrites(base({ everArmed: true })).pass, false);
    const c = checkWrites(base({ witness: [{ ref: 'a|1', method: 'POST', path: '/_api/x', phase: 'fill', responded: true, blocked: false }] }));
    assert.equal(c.pass, false);
    assert.ok(c.evidence.violations.some((v) => /answered/.test(v)), JSON.stringify(c.evidence.violations));
  });

  it('fails on an allowed write for any other reason (unparsed, scheme)', () => {
    assert.equal(checkWrites(base({ decisions: [signIn, w({ portal: false, host: '', action: 'continue', reason: 'unparsed' })] })).pass, false);
  });

  it('is null when filling never started', () => {
    assert.equal(checkWrites(base({ fillReached: false })).pass, null);
  });
});

describe('verdict', () => {
  const all = (pass) => CHECK_IDS.map((id) => ({ id, pass }));
  it('ok only when all six checks ran exactly once and passed', () => {
    assert.deepEqual(CHECK_IDS, ['portal_user', 'allowance_labels', 'field_ids', 'validators', 'timezone_default', 'writes_blocked']);
    assert.equal(verdict(all(true)), true);
    assert.equal(verdict(all(true).slice(1)), false, 'a missing check');
    assert.equal(verdict([...all(true), { id: 'portal_user', pass: true }]), false, 'a duplicate');
    assert.equal(verdict(all(true).map((c, i) => (i === 2 ? { ...c, pass: null } : c))), false, 'null is not a pass');
    assert.equal(verdict(all(true).map((c, i) => (i === 2 ? { ...c, pass: 'yes' } : c))), false, 'truthy is not a pass');
  });
});

describe('coverage: no scenario may drop out silently (review findings)', () => {
  it('portal_user fails when any scenario lacks Portal.User or bound someone else, even if another bound correctly', () => {
    const absent = scen('external', { user: { present: false, email: null, userName: null }, owner: { reached: true, defaulted: false, upn: null, guid: false } });
    const c = checkPortalUser([scen('internal'), absent]);
    assert.equal(c.pass, false, c.detail);
    assert.match(c.detail, /Hybrid\/external/);
    const other = scen('external', { owner: { reached: true, defaulted: true, upn: 'bob@contoso.com', guid: true } });
    assert.equal(checkPortalUser([scen('internal'), other]).pass, false);
  });

  it('portal_user is null when a scenario expected to reach the owner never did', () => {
    const stopped = scen('external', { expected: [...COMMON, ...DEP.external], applies: ['purpose'], owner: { reached: false } });
    const c = checkPortalUser([scen('internal'), stopped]);
    assert.equal(c.pass, null, c.detail);
    assert.match(c.detail, /Hybrid\/external/);
  });

  it('field_ids and validators are null when an expected slot of some scenario was never bound', () => {
    const stopped = scen('external', { expected: [...COMMON, ...DEP.external], applies: ['title', 'purpose', 'type', 'owner'] });
    const other = { ...scen('external'), name: 'Other/external' };
    for (const fn of [checkFieldIds, checkValidators]) {
      const c = fn([scen('internal'), other, stopped]);
      assert.equal(c.pass, null, `${c.id}: ${c.detail}`);
      assert.deepEqual(c.evidence.slots.tenantName.unverifiedIn, ['Hybrid/external']);
      assert.match(c.detail, /tenantName/);
    }
  });

  it('allowance_labels and timezone_default are null when a scenario expected to show them did not', () => {
    const lost = { ...scen('internal', { expected: [...COMMON, ...DEP.internal], applies: COMMON, allowance: null, timezone: null }), name: 'Other/internal' };
    for (const fn of [checkAllowance, checkTimezone]) {
      const c = fn([scen('internal'), lost]);
      assert.equal(c.pass, null, `${c.id}: ${c.detail}`);
      assert.ok(c.evidence.scenarios.some((r) => r.scenario === 'Other/internal' && r.pass === null), JSON.stringify(c.evidence.scenarios));
    }
  });

  it('a scoped run can never pass field_ids or validators, even when every slot was covered', () => {
    const checks = CHECK_IDS.map((id) => ({ id, pass: true, evidence: {}, detail: 'ok' }));
    const out = narrowToScope(checks, { purpose: 'Hybrid' });
    assert.equal(out.find((c) => c.id === 'field_ids').pass, null);
    assert.equal(out.find((c) => c.id === 'validators').pass, null);
    assert.match(out.find((c) => c.id === 'field_ids').detail, /--purpose/);
    assert.equal(verdict(out), false);
    assert.deepEqual(narrowToScope(checks, {}), checks, 'a full run is untouched');
    const failed = checks.map((c) => (c.id === 'validators' ? { ...c, pass: false } : c));
    assert.equal(narrowToScope(failed, { type: 'internal' }).find((c) => c.id === 'validators').pass, false, 'a refutation stays a refutation');
  });
});
