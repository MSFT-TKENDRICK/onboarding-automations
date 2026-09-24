import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOption, matchOwner, ownerSearchTerm, normalize, parseSuggestion } from '../../skills/request-new-azure-subscription/scripts/lib/match.mjs';

const purposes = [
  { value: '', label: 'Select' },
  { value: '444350001', label: 'Hybrid (Self-Learning/Demo)' },
  { value: '444350003', label: 'CSS Support' },
  { value: '444350004', label: 'Customer Project' },
];
const types = [
  { value: '', label: 'Select' },
  { value: '444350000', label: 'Internal Subscription' },
  { value: '444350001', label: 'External Subscription' },
];
const money = [
  { value: '', label: '' },
  { value: '500', label: '$500' },
  { value: '1000', label: '$1000' },
  { value: '1500', label: '$1500' },
];
const tz = [
  { value: '', label: 'Select' },
  { value: 'g-pst', label: '(UTC-08:00) Pacific Time (US & Canada)' },
  { value: 'g-baja', label: '(UTC-08:00) Baja California' },
  { value: 'g-est', label: '(UTC-05:00) Eastern Time (US & Canada)' },
  { value: 'g-ist', label: '(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi' },
  { value: 'g-utc', label: '(UTC) Coordinated Universal Time' },
];

test('normalize collapses case, whitespace and nbsp', () => {
  assert.equal(normalize('  Internal\u00a0 Subscription '), 'internal subscription');
});

test('exact option value wins', () => {
  assert.deepEqual(matchOption(types, '444350000'), { ok: true, value: '444350000', label: 'Internal Subscription', matchedBy: 'value' });
});

test('case-insensitive label match', () => {
  const r = matchOption(types, 'external subscription');
  assert.equal(r.ok, true);
  assert.equal(r.value, '444350001');
  assert.equal(r.matchedBy, 'label');
});

test('unique partial match is accepted but flagged', () => {
  const r = matchOption(purposes, 'hybrid');
  assert.equal(r.ok, true);
  assert.equal(r.value, '444350001');
  assert.equal(r.matchedBy, 'partial');
  assert.equal(matchOption(types, 'Internal').value, '444350000');
});

test('placeholder options are never matched', () => {
  const r = matchOption(types, 'select');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_match');
  assert.equal(matchOption(types, '').ok, false);
});

test('unavailable choice reports no_match with the real candidates', () => {
  const r = matchOption([{ value: '', label: 'Select' }, purposes[1]], 'Customer Project');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_match');
  assert.deepEqual(r.candidates, ['Hybrid (Self-Learning/Demo)']);
});

test('ambiguous partial reports candidates, never picks one', () => {
  const r = matchOption(tz, 'UTC-08:00');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous');
  assert.deepEqual(r.candidates.sort(), ['(UTC-08:00) Baja California', '(UTC-08:00) Pacific Time (US & Canada)']);
});

test('money matching accepts $ and separators', () => {
  assert.equal(matchOption(money, '$1,000', { kind: 'money' }).value, '1000');
  assert.equal(matchOption(money, '500 USD', { kind: 'money' }).value, '500');
  assert.equal(matchOption(money, 500, { kind: 'money' }).value, '500');
  const bad = matchOption(money, '750', { kind: 'money' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.candidates, ['$500', '$1000', '$1500']);
});

test('money matching does not treat 1500 as partial of 500', () => {
  assert.equal(matchOption(money, '50', { kind: 'money' }).ok, false);
});

test('time zone accepts IANA names via built-in map', () => {
  assert.equal(matchOption(tz, 'America/Los_Angeles', { kind: 'timezone' }).value, 'g-pst');
  assert.equal(matchOption(tz, 'Asia/Kolkata', { kind: 'timezone' }).value, 'g-ist');
  assert.equal(matchOption(tz, 'Pacific Time', { kind: 'timezone' }).value, 'g-pst');
  assert.equal(matchOption(tz, 'Etc/UTC', { kind: 'timezone' }).value, 'g-utc');
});

test('multi-word partial requires all tokens', () => {
  assert.equal(matchOption(tz, 'eastern us', { kind: 'timezone' }).value, 'g-est');
  assert.equal(matchOption(tz, 'eastern europe', { kind: 'timezone' }).ok, false);
});

test('parseSuggestion splits display name and UPN', () => {
  assert.deepEqual(parseSuggestion('Tyler Kendrick;tykendrick@microsoft.com'), { display: 'Tyler Kendrick', upn: 'tykendrick@microsoft.com' });
  assert.deepEqual(parseSuggestion('  Jane Doe ; JDOE@Microsoft.com '), { display: 'Jane Doe', upn: 'jdoe@microsoft.com' });
  assert.deepEqual(parseSuggestion('No Upn Here'), { display: 'No Upn Here', upn: '' });
});

const sugg = ['Tyler Kendrick;tykendrick@microsoft.com', 'Tyler Kendricks;tkendricks@microsoft.com', 'Ty Kendrick;tkendrick@contoso.com'];

test('owner match by exact UPN', () => {
  assert.deepEqual(matchOwner(sugg, 'TYKENDRICK@microsoft.com'), { ok: true, index: 0, display: 'Tyler Kendrick', upn: 'tykendrick@microsoft.com', matchedBy: 'upn' });
});

test('owner match by alias uses UPN local part only', () => {
  const r = matchOwner(sugg, 'tkendricks');
  assert.equal(r.ok, true);
  assert.equal(r.index, 1);
  assert.equal(r.matchedBy, 'alias');
});

test('owner alias matching two tenants is ambiguous', () => {
  const r = matchOwner(['A;tkendrick@microsoft.com', 'B;tkendrick@contoso.com'], 'tkendrick');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous');
});

test('owner never partially matches people', () => {
  const r = matchOwner(sugg, 'Tyler');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_match');
  assert.equal(r.candidates.length, 3);
});

test('owner match by exact unique display name', () => {
  assert.equal(matchOwner(sugg, 'tyler kendrick').index, 0);
  const dup = matchOwner(['Jane Doe;jd1@microsoft.com', 'Jane Doe;jd2@microsoft.com'], 'Jane Doe');
  assert.equal(dup.error, 'ambiguous');
});

test('ownerSearchTerm uses alias for emails', () => {
  assert.equal(ownerSearchTerm('JDoe@microsoft.com'), 'jdoe');
  assert.equal(ownerSearchTerm(' Jane Doe '), 'Jane Doe');
  assert.throws(() => ownerSearchTerm('ab'), /at least 3/);
});
