import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { optionCriteria, decideIntent, INTENT_SLOTS } from '../../skills/request-new-azure-subscription/scripts/lib/intent.mjs';

const opts = [
  { value: '1', label: '(UTC-08:00) Pacific Time (US & Canada)' },
  { value: '2', label: '(UTC-05:00) Eastern Time (US & Canada)' },
  { value: '', label: 'Select' },
];

describe('optionCriteria', () => {
  it('maps real options to opaque keys, drops placeholders and appends an explicit none', () => {
    const { criteria, keyToValue } = optionCriteria(opts, (s) => s);
    assert.deepEqual(Object.keys(criteria), ['o1', 'o2', 'none']);
    assert.equal(keyToValue.o1, '1');
    assert.equal(keyToValue.none, undefined);
    assert.match(criteria.none, /none/i);
  });
  it('passes labels through the redactor', () => {
    const { criteria } = optionCriteria([{ value: 'a', label: 'Owned by bob@contoso.com' }], (s) => s.replace(/\S+@\S+/, '[email]'));
    assert.equal(criteria.o1, 'Owned by [email]');
  });
});

describe('decideIntent', () => {
  const map = { o1: '1', o2: '2' };
  const v = (probabilities) => {
    const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    return { ok: true, choice: ranked[0][0], p: ranked[0][1], margin: ranked[0][1] - (ranked[1]?.[1] ?? 0), probabilities };
  };
  it('commits a clear leader', () => {
    assert.deepEqual(decideIntent(v({ o1: 0.95, o2: 0.03, none: 0.02 }), map), { commit: true, value: '1', p: 0.95 });
  });
  it('refuses when the leader is none', () => {
    assert.equal(decideIntent(v({ none: 0.97, o1: 0.02, o2: 0.01 }), map).reason, 'none');
  });
  it('refuses below the commit threshold', () => {
    assert.equal(decideIntent(v({ o1: 0.89, o2: 0.1, none: 0.01 }), map).reason, 'low_confidence');
  });
  it('refuses with a narrow margin even when p is high enough', () => {
    const r = decideIntent({ ok: true, choice: 'o1', p: 0.9, margin: 0.29, probabilities: {} }, map);
    assert.equal(r.reason, 'narrow_margin');
  });
  it('refuses a failed or invalid model answer', () => {
    assert.equal(decideIntent({ ok: false, error: 'timeout' }, map).reason, 'no_answer');
    assert.equal(decideIntent(v({ o9: 0.99, none: 0.01 }), map).reason, 'unknown_key');
  });
  it('only allows intent resolution for non-identity slots', () => {
    assert.deepEqual([...INTENT_SLOTS].sort(), ['purpose', 'tenantLicensing', 'tenantType', 'timezone']);
    assert.equal(INTENT_SLOTS.has('owner'), false);
    assert.equal(INTENT_SLOTS.has('allowance'), false);
  });
});
