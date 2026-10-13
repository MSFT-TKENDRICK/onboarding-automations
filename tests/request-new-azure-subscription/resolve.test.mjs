import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOTS, CARRIERS, attestBinding, resolveSlot, fingerprint, validateMap } from '../../skills/request-new-azure-subscription/scripts/lib/resolve.mjs';

const P = 'ctl00$form$';
const opts = (...pairs) => [{ value: '', label: 'Select' }, ...pairs.map(([value, label]) => ({ value, label }))];
const TZ = opts(['tz-pst', '(UTC-08:00) Pacific Time (US & Canada)'], ['tz-est', '(UTC-05:00) Eastern Time (US & Canada)'], ['tz-utc', '(UTC) Coordinated Universal Time']);
const MONEY = opts(['500', '$500'], ['1000', '$1000']);
const TYPES = opts(['1', 'Internal Subscription'], ['2', 'External Subscription']);
const sel = (id, label, options, extra = {}) => ({ id, tag: 'select', type: 'select-one', name: `${P}${id}`, label, visible: true, readonly: false, required: true, value: '', options, ...extra });
const txt = (id, label, extra = {}) => ({ id, tag: 'input', type: 'text', name: `${P}${id}`, label, visible: true, readonly: false, required: true, value: '', ...extra });
const radio = (id, label, options, extra = {}) => ({ id, tag: 'input', type: 'radio', name: `${P}${id}`, label, visible: true, readonly: false, required: true, value: '', options: options.filter((o) => o.value), ...extra });

const form = () => [
  txt('apitil_title', 'Title'),
  sel('desitsm_subscriptionpurposeaz', 'Subscription Purpose', opts(['1', 'Hybrid'])),
  sel('desitsm_subscriptiontypes', 'Subscription Type', TYPES),
  txt('desitsm_subscriptionowner', 'Subscription Owner'),
  sel('desitsm_monthlyspend', 'Monthly Allowance', MONEY),
  sel('desitsm_timezonelist', 'Time Zone', TZ),
  sel('desitsm_tenanttypes', 'Tenant Type', opts(['3', 'Team Tenant']), { visible: false }),
  txt('desitsm_tenantdisplayname', 'Tenant Display Name', { visible: false }),
  txt('desitsm_eslabs_projectlevel', 'Reporting Manager', { readonly: true }),
];
const swap = (fields, id, patch) => fields.map((f) => (f.id === id ? (patch === null ? null : { ...f, ...patch }) : f)).filter(Boolean);
const R = (key, fields, opts2) => resolveSlot(key, SLOT_IDS[key], fields, opts2);
const SLOT_IDS = { title: 'apitil_title', purpose: 'desitsm_subscriptionpurposeaz', type: 'desitsm_subscriptiontypes', owner: 'desitsm_subscriptionowner', allowance: 'desitsm_monthlyspend', timezone: 'desitsm_timezonelist', tenantType: 'desitsm_tenanttypes', tenantLicensing: 'desitsm_tenantlicensing', tenantName: 'desitsm_tenantdisplayname' };

test('every slot has a canonical label, a label rule and a kind', () => {
  for (const [k, s] of Object.entries(SLOTS)) {
    assert.ok(['text', 'choice', 'lookup'].includes(s.kind), k);
    assert.ok(s.labels.length && s.labels.every((l) => s.re(l.toLowerCase())), k);
  }
});

test('id tier: the expected id is used when it is visible, compatible and labelled consistently', () => {
  for (const key of ['title', 'purpose', 'type', 'owner', 'allowance', 'timezone']) {
    const r = R(key, form());
    assert.equal(r.ok, true, `${key}: ${JSON.stringify(r)}`);
    assert.equal(r.via, 'id');
    assert.equal(r.id, SLOT_IDS[key]);
  }
});

test('id tier rejects a repurposed id (label contradicts) and does not guess', () => {
  const f = swap(form(), 'desitsm_timezonelist', { label: 'Cost Center' });
  const r = R('timezone', f);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'field_drift');
  assert.equal(r.expectedId, 'desitsm_timezonelist');
  assert.equal(r.label, 'Cost Center');
});

test('id tier rejects a failed option signature, a wrong kind, readonly and an empty label', () => {
  assert.equal(R('allowance', swap(form(), 'desitsm_monthlyspend', { options: opts(['a', 'Low'], ['b', 'High']) })).code, 'field_drift');
  assert.equal(R('timezone', swap(form(), 'desitsm_timezonelist', { options: MONEY })).code, 'field_drift');
  assert.equal(R('type', swap(form(), 'desitsm_subscriptiontypes', { options: opts(['1', 'Gold'], ['2', 'Silver']) })).code, 'field_drift');
  assert.equal(R('title', swap(form(), 'apitil_title', { tag: 'textarea', type: 'textarea' })).ok, true);
  assert.equal(R('title', swap(form(), 'apitil_title', { tag: 'select', type: 'select-one', options: opts(['1', 'x']) })).code, 'field_drift');
  assert.equal(R('title', swap(form(), 'apitil_title', { readonly: true })).code, 'field_drift');
  // An unlabelled control is not evidence it is still the same field.
  assert.equal(R('allowance', swap(form(), 'desitsm_monthlyspend', { label: '' })).code, 'field_drift');
});

test('renamed tier heals a pure rename (same canonical label) and reports it', () => {
  const f = swap(form(), 'desitsm_timezonelist', { id: 'desitsm_tz_v2', name: `${P}desitsm_tz_v2` });
  const r = R('timezone', f);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.via, 'renamed');
  assert.equal(r.id, 'desitsm_tz_v2');
  const t = R('type', swap(form(), 'desitsm_subscriptiontypes', { id: 'x_type2' }));
  assert.equal(t.via, 'renamed');
});

test('renamed tier needs an exact canonical label, the signature and no other matching label', () => {
  const renamed = swap(form(), 'desitsm_timezonelist', { id: 'desitsm_tz_v2' });
  // Label only similar: never auto-healed, but suggested.
  const similar = R('timezone', swap(renamed, 'desitsm_tz_v2', { label: 'Time zone (local)' }));
  assert.equal(similar.code, 'field_drift');
  assert.equal(similar.suggested.id, 'desitsm_tz_v2');
  // Signature fails.
  assert.equal(R('timezone', swap(renamed, 'desitsm_tz_v2', { options: MONEY })).code, 'field_drift');
  // Another visible field also matches the slot's label rule.
  const other = [...renamed, sel('x_other', 'Preferred time zone', opts(['a', 'Morning']))];
  assert.equal(R('timezone', other).code, 'field_drift');
});

test('duplicate canonical labels are drift with no suggestion', () => {
  const f = [...swap(form(), 'desitsm_timezonelist', { id: 'desitsm_tzone' }), sel('desitsm_tzdup', 'Time Zone', TZ)];
  const r = R('timezone', f);
  assert.equal(r.code, 'field_drift');
  assert.equal(r.suggested, undefined);
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), ['desitsm_tzdup', 'desitsm_tzone']);
});

test('a unique heuristic best is suggested (never applied); a small margin is not', () => {
  const relabel = R('timezone', swap(form(), 'desitsm_timezonelist', { label: 'Local Time' }));
  assert.equal(relabel.ok, false);
  assert.equal(relabel.suggested.id, 'desitsm_timezonelist');
  assert.ok(relabel.suggested.evidence.includes('signature'));
  assert.ok(relabel.candidates.length <= 5);
  // Two relabelled numeric selects: same evidence, no suggestion.
  const f = [...swap(form(), 'desitsm_monthlyspend', { id: 'x_a', label: 'Amount' }), sel('x_b', 'Quota', MONEY)];
  const tie = R('allowance', f);
  assert.equal(tie.code, 'field_drift');
  assert.equal(tie.suggested, undefined);
});

test('assignment is one-to-one: claimed fields are never candidates', () => {
  const f = swap(form(), 'desitsm_timezonelist', { id: 'desitsm_tz_v2' });
  assert.equal(R('timezone', f, { claimed: new Set(['desitsm_tz_v2']) }).ok, false);
  assert.equal(R('allowance', form(), { claimed: new Set(['desitsm_monthlyspend']) }).ok, false);
});

test('owner is never renamed or mapped', () => {
  const f = swap(form(), 'desitsm_subscriptionowner', { id: 'desitsm_owner2' });
  const r = R('owner', f);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'field_drift');
  assert.equal(r.suggested, undefined);
  assert.equal(R('owner', f, { mapped: 'desitsm_owner2' }).code, 'invalid_mapping');
});

test('mapped tier: explicit --map is used only when the target passes every hard check', () => {
  const f = swap(form(), 'desitsm_timezonelist', { label: 'Local Time' });
  const ok = R('timezone', f, { mapped: 'desitsm_timezonelist' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.via, 'mapped');
  const bad = (mapped, fields = f, extra = {}) => R('timezone', fields, { mapped, ...extra });
  assert.equal(bad('nope').reason, 'not_found');
  assert.equal(bad('desitsm_monthlyspend').reason, 'signature');
  assert.equal(bad('apitil_title').reason, 'kind');
  assert.equal(bad('desitsm_eslabs_projectlevel').reason, 'kind');
  assert.equal(bad('desitsm_timezonelist', swap(f, 'desitsm_timezonelist', { visible: false })).reason, 'hidden');
  assert.equal(bad('desitsm_timezonelist', swap(f, 'desitsm_timezonelist', { readonly: true })).reason, 'readonly');
  assert.equal(bad('desitsm_timezonelist', f, { claimed: new Set(['desitsm_timezonelist']) }).reason, 'claimed');
  for (const r of [bad('nope'), bad('desitsm_monthlyspend')]) assert.equal(r.code, 'invalid_mapping');
});

test('radio groups are valid choice fields', () => {
  const f = swap(form(), 'desitsm_subscriptiontypes', null).concat(radio('desitsm_subscriptiontypes', 'Subscription Type', TYPES));
  const r = R('type', f);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.via, 'id');
  assert.equal(R('title', [radio('apitil_title', 'Title', TYPES)]).code, 'field_drift');
});

test('hidden dependents are not resolved; an absent one is drift only when it is applicable, given or evidenced', () => {
  assert.equal(R('tenantType', form(), { optional: true }).code, 'not_shown');
  const absent = swap(form(), 'desitsm_tenanttypes', null);
  assert.equal(R('tenantType', absent, { optional: true }).code, 'not_shown');
  assert.equal(R('tenantType', absent, { optional: true, given: true }).code, 'field_drift');
  assert.equal(R('tenantType', absent, { optional: true, applicable: true }).code, 'field_drift');
  // A signature-bearing candidate is evidence the slot is shown under another id.
  const tz = swap(form(), 'desitsm_timezonelist', { id: 'x1', label: 'Zone' });
  assert.equal(R('timezone', tz, { optional: true }).code, 'field_drift');
  // Top-level slots are never "not shown" when absent.
  assert.equal(R('title', swap(form(), 'apitil_title', null)).code, 'field_drift');
});

test('a hidden expected dependent the selected type should show is drift, with the replacement suggested', () => {
  const f = [...swap(form(), 'desitsm_monthlyspend', { visible: false }), sel('desitsm_monthlybudget', 'Monthly Budget', MONEY)];
  const r = R('allowance', f, { optional: true, applicable: true, given: true });
  assert.equal(r.code, 'field_drift', JSON.stringify(r));
  assert.equal(r.suggested.id, 'desitsm_monthlybudget');
  assert.equal(R('allowance', f, { optional: true, applicable: true }).code, 'field_drift');
  // Not applicable for the selected type: still just not shown (the input is ignored with a warning).
  assert.equal(R('allowance', f, { optional: true, given: true }).code, 'not_shown');
});

test('validator proof heals a relabel+rename when page validators name the canonical label for one eligible control', () => {
  const f = swap(form(), 'desitsm_timezonelist', { id: 'x_lt', name: `${P}x_lt`, label: 'Local Time' });
  const validators = [{ control: 'x_lt', message: 'Time Zone is a required field.' }, { control: 'apitil_title', message: 'Title is a required field.' }];
  const r = R('timezone', f, { validators });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.via, 'validator');
  assert.equal(r.id, 'x_lt');
  assert.deepEqual(r.evidence, { message: 'Time Zone is a required field.' });
  // Without validators: layer 2 behaviour (drift with a suggestion), plus the legal pool for ranking.
  const d = R('timezone', f);
  assert.equal(d.code, 'field_drift');
  assert.equal(d.suggested.id, 'x_lt');
  assert.deepEqual(d.pool, ['x_lt']);
});

test('validator proof is void for owner, reserved, claimed, signature-failing and duplicated controls', () => {
  const owner = swap(form(), 'desitsm_subscriptionowner', { id: 'x_owner', label: 'Owner (new)' });
  assert.equal(R('owner', owner, { validators: [{ control: 'x_owner', message: 'Subscription Owner is a required field.' }] }).code, 'field_drift');
  const f = swap(form(), 'desitsm_timezonelist', { id: 'x_lt', label: 'Local Time' });
  const val = [{ control: 'x_lt', message: 'Time Zone is a required field.' }];
  const reservedRun = R('timezone', f, { validators: val, reserved: new Set(['x_lt']) });
  assert.equal(reservedRun.code, 'field_drift');
  assert.deepEqual(reservedRun.pool, []);
  assert.equal(R('timezone', f, { validators: val, claimed: new Set(['x_lt']) }).code, 'field_absent');
  const money = swap(form(), 'desitsm_timezonelist', { id: 'x_lt', label: 'Local Time', options: MONEY });
  assert.notEqual(R('timezone', money, { validators: val }).via, 'validator');
  const dup = [...f, sel('x_lt2', 'Local Time', TZ)];
  const two = R('timezone', dup, { validators: [...val, { control: 'x_lt2', message: 'Time Zone is a required field.' }] });
  assert.equal(two.code, 'field_drift');
  assert.deepEqual([...two.pool].sort(), ['x_lt', 'x_lt2']);
});

test('field_absent only when the expected id is gone and nothing legal or similar remains', () => {
  const gone = swap(form(), 'desitsm_timezonelist', null);
  const r = R('timezone', gone, { validators: [] });
  assert.equal(r.code, 'field_absent', JSON.stringify(r));
  assert.equal(r.expectedId, 'desitsm_timezonelist');
  // A changed control (still there, signature fails) is drift, not absent.
  assert.equal(R('timezone', swap(form(), 'desitsm_timezonelist', { options: MONEY }), { validators: [] }).code, 'field_drift');
  // Another slot's own control is not a legal candidate.
  const t = R('tenantType', swap(form(), 'desitsm_tenanttypes', null), { optional: true, applicable: true, reserved: new Set(Object.values(SLOT_IDS)) });
  assert.equal(t.code, 'field_absent', JSON.stringify(t));
  // Legal pool: eligible (signature ok), heuristic order, no reserved ids.
  const d = R('tenantType', swap(form(), 'desitsm_tenanttypes', null), { optional: true, applicable: true, reserved: new Set(['desitsm_subscriptiontypes']) });
  assert.equal(d.code, 'field_drift');
  assert.ok(!d.pool.includes('desitsm_subscriptiontypes'), JSON.stringify(d.pool));
  assert.ok(d.pool.includes('desitsm_timezonelist'));
});

test('fingerprint covers the descriptor (not the value) and ignores option order', () => {
  const a = sel('x', 'Time Zone', TZ);
  assert.equal(fingerprint(a), fingerprint({ ...a, value: 'tz-pst', required: false, visible: false }));
  assert.equal(fingerprint(a), fingerprint({ ...a, options: [...TZ].reverse() }));
  for (const patch of [{ label: 'Zone' }, { name: 'y' }, { tag: 'input' }, { type: 'radio' }, { readonly: true }, { options: TZ.slice(1) }, { options: TZ.map((o) => (o.value === 'tz-pst' ? { ...o, label: 'PST' } : o)) }]) {
    assert.notEqual(fingerprint(a), fingerprint({ ...a, ...patch }), JSON.stringify(patch));
  }
  assert.match(fingerprint(a), /^[0-9a-f]{64}$/);
});

test('validateMap checks slot names, id syntax, uniqueness and reserved ids before anything runs', () => {
  const reserved = new Set(['itserv_businessmanageruserid']);
  const v = (map) => validateMap(map, { expected: SLOT_IDS, reserved });
  assert.deepEqual(v({ timezone: ' desitsm_tz_v2 ' }), { ok: true, map: { timezone: 'desitsm_tz_v2' } });
  assert.deepEqual(v({}), { ok: true, map: {} });
  assert.equal(v({ nope: 'x' }).ok, false);
  assert.equal(v({ owner: 'x' }).ok, false);
  assert.equal(v({ timezone: 'bad id!' }).ok, false);
  assert.equal(v({ timezone: '' }).ok, false);
  assert.equal(v({ timezone: 'x', allowance: 'x' }).ok, false);
  assert.equal(v({ timezone: 'itserv_businessmanageruserid' }).ok, false);
  // Another slot's own field is off limits unless that slot is explicitly mapped elsewhere (a swap).
  assert.equal(v({ allowance: 'desitsm_timezonelist' }).ok, false);
  assert.equal(v({ allowance: 'desitsm_timezonelist', timezone: 'desitsm_monthlyspend' }).ok, true);
  assert.equal(v({ timezone: 'desitsm_timezonelist' }).ok, true);
  assert.match(v({ nope: 'x' }).errors[0], /nope/);
});

// Live shape (2026-09-28): the allowance <select> is unnamed; a hidden named text input carries the value.
const CAR = `${P}desitsm_estimatedmonthlyspend`;
const unnamed = { id: 'desitsm_monthlyspend', name: '', carrier: { id: 'desitsm_estimatedmonthlyspend', name: CAR } };

test('CARRIERS: a static allowlist (allowance select -> hidden estimated-spend carrier), nothing else', () => {
  assert.deepEqual(CARRIERS, { allowance: { of: 'desitsm_monthlyspend', id: 'desitsm_estimatedmonthlyspend' } });
  assert.ok(Object.isFrozen(CARRIERS) && Object.isFrozen(CARRIERS.allowance));
});

test('attestBinding: an unnamed select is attested through its pinned carrier posting exactly the selected value', () => {
  const ok = attestBinding(unnamed, '1500', { control: [], count: 1, carrier: [[CAR, '1500']] }, [[CAR, '1500']]);
  assert.equal(ok, null);
  assert.equal(attestBinding(unnamed, '1500', { control: [], count: 1, carrier: [[CAR, '500']] }, [[CAR, '500']]), 'value_changed', 'mirror lagging or wrong');
  assert.equal(attestBinding(unnamed, '1500', { control: [], count: 1, carrier: [] }, []), 'unbound', 'carrier missing/disabled/outside the form');
  assert.equal(attestBinding(unnamed, '1500', { control: [], count: 1, carrier: [[CAR, '1500']] }, [[CAR, '1500'], [CAR, '1500']]), 'unbound', 'carrier name serialized twice');
  assert.equal(attestBinding(unnamed, '1500', { control: [], count: 1, carrier: [[`${CAR}x`, '1500']] }, [[`${CAR}x`, '1500']]), 'unbound', 'carrier renamed since the pin');
  assert.equal(attestBinding({ ...unnamed, carrier: null }, '1500', { control: [], count: 1, carrier: [[CAR, '1500']] }, [[CAR, '1500']]), 'unbound', 'no carrier pinned at bind');
  assert.equal(attestBinding({ id: 'desitsm_monthlyspend', name: '' }, '1500', { control: [] }, []), 'unbound', 'no carrier declared');
});

test('attestBinding: an unnamed control must be proven a single element (a duplicate id could post unattested)', () => {
  const S = `${P}desitsm_monthlyspend`;
  // formBinding returns [] for a duplicated id; that must never read as "the unnamed select posts nothing".
  const dup = [[CAR, '1500'], [S, '100000']];
  assert.equal(attestBinding(unnamed, '1500', { control: [], count: 2, carrier: [[CAR, '1500']] }, dup), 'unbound', 'duplicated id');
  assert.equal(attestBinding(unnamed, '1500', { control: [], carrier: [[CAR, '1500']] }, [[CAR, '1500']]), 'unbound', 'count not proven');
  assert.equal(attestBinding(unnamed, '1500', { control: [], count: 0, carrier: [[CAR, '1500']] }, [[CAR, '1500']]), 'unbound', 'control gone');
});

test('attestBinding: an unnamed select that starts posting, or a named select with a carrier, must agree', () => {
  const S = `${P}desitsm_monthlyspend`;
  assert.equal(attestBinding(unnamed, '1500', { control: [[S, '1500']], carrier: [[CAR, '1500']] }, [[S, '1500'], [CAR, '1500']]), 'unbound', 'select gained a name after the pin');
  const named = { ...unnamed, name: S };
  assert.equal(attestBinding(named, '1500', { control: [[S, '1500']], carrier: [[CAR, '1500']] }, [[S, '1500'], [CAR, '1500']]), null);
  assert.equal(attestBinding(named, '1500', { control: [[S, '1500']], carrier: [[CAR, '500']] }, [[S, '1500'], [CAR, '500']]), 'value_changed', 'both named: both post the value');
  assert.equal(attestBinding(named, '1500', { control: [[S, '1500']], carrier: [] }, [[S, '1500']]), 'unbound', 'pinned carrier vanished');
  assert.equal(attestBinding({ id: 'x', name: S }, '1500', { control: [[S, '1500']] }, [[S, '1500']]), null, 'plain slot: unchanged rule');
  assert.equal(attestBinding({ id: 'x', name: S }, undefined, { control: [[S, 'anything']] }, [[S, 'anything']]), null, 'owner: value not checked');
  assert.equal(attestBinding({ id: 'x', name: S }, 'a\nb', { control: [[S, 'a\r\nb']] }, [[S, 'a\r\nb']]), null, 'newlines post as CRLF');
});

test('resolveSlot: the allowance validator proof holds across the select and its declared carrier (live split)', () => {
  const fields = [
    sel('desitsm_monthlyspend', 'Cap', MONEY, { name: '' }),
    txt('desitsm_estimatedmonthlyspend', 'Monthly Allowance', { visible: false }),
  ];
  const validators = [
    { control: 'desitsm_monthlyspend', message: 'Monthly Allowance is a required field.', enabled: true },
    { control: 'desitsm_estimatedmonthlyspend', message: 'Monthly Allowance must have a value between -922,337,203,685,477.0000 and 922,337,203,685,477.0000.', enabled: true },
  ];
  const r = resolveSlot('allowance', 'desitsm_monthlyspend', fields, { validators, reserved: new Set(['desitsm_estimatedmonthlyspend']) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.via, 'validator');
  assert.equal(r.id, 'desitsm_monthlyspend');
  const moved = resolveSlot('allowance', 'desitsm_monthlyspend', [{ ...fields[0], id: 'new_spend' }, fields[1]], { validators: [{ ...validators[0], control: 'new_spend' }, validators[1]], reserved: new Set(['desitsm_estimatedmonthlyspend']) });
  assert.equal(moved.ok, false, 'the alias only covers the declared pair: a moved select is not proven');
});

test('resolveSlot: a longer label on another control does not void a proof (live owner-style labels)', () => {
  const fields = [sel('new_tz', 'Zone', TZ), txt('desitsm_secondtimezonenote', 'Secondary Time Zone Note', { visible: false })];
  const validators = [
    { control: 'new_tz', message: 'Time Zone is a required field.', enabled: true },
    { control: 'desitsm_secondtimezonenote', message: 'Secondary Time Zone Note exceeds the maximum length of 100 characters.', enabled: true },
  ];
  const r = resolveSlot('timezone', 'desitsm_timezonelist', fields, { validators });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.id, 'new_tz');
});