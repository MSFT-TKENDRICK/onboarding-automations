import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatorProof, validatorLabel } from '../../skills/request-new-azure-subscription/scripts/lib/drift.mjs';

// Canonical labels per slot (mirrors the live portal / layer 2 slot specs).
const LABELS = { title: 'Title', allowance: 'Monthly Allowance', timezone: 'Time Zone', type: 'Subscription Type', tenantType: 'Tenant Type' };
const v = (control, message) => ({ control, message });

describe('validatorLabel', () => {
  it('matches a canonical label as a whole phrase, case-insensitively', () => {
    assert.equal(validatorLabel('Monthly Allowance is a required field.', 'Monthly Allowance'), true);
    assert.equal(validatorLabel('monthly allowance is required', 'Monthly Allowance'), true);
    assert.equal(validatorLabel('Estimated Monthly Allowanceness', 'Monthly Allowance'), false);
    assert.equal(validatorLabel('Subscription Types list', 'Subscription Type'), false);
  });
});

describe('validatorProof', () => {
  const eligible = new Set(['new_spend', 'other_select']);
  it('proves a unique validator -> eligible control association', () => {
    const r = validatorProof('allowance', [v('new_spend', 'Monthly Allowance is a required field.'), v('x', 'Title is a required field.')], eligible, LABELS);
    assert.deepEqual(r, { ok: true, id: 'new_spend', evidence: { message: 'Monthly Allowance is a required field.' } });
  });
  it('is void when no validator names the slot', () => {
    assert.equal(validatorProof('allowance', [v('new_spend', 'Please fill this in')], eligible, LABELS).ok, false);
  });
  it('is void for a compound message naming another slot', () => {
    const r = validatorProof('type', [v('other_select', 'Subscription Type and Tenant Type are required.')], new Set(['other_select']), LABELS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'compound_message');
  });
  it('is void when validators naming the slot point at different controls', () => {
    const r = validatorProof('allowance', [v('new_spend', 'Monthly Allowance is required'), v('other_select', 'Monthly Allowance must be chosen')], eligible, LABELS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'multiple_controls');
  });
  it('is void when the proven control is not eligible', () => {
    const r = validatorProof('allowance', [v('hidden_spend', 'Monthly Allowance is required')], eligible, LABELS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ineligible_control');
  });
  it('is void when another slot also proves the same control', () => {
    const r = validatorProof('allowance', [v('new_spend', 'Monthly Allowance is required'), v('new_spend', 'Time Zone is required')], eligible, LABELS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'shared_control');
  });
  it('does not treat a longer label containing a shorter one as compound (Tenant Type vs Type)', () => {
    const r = validatorProof('tenantType', [v('other_select', 'Tenant Type is a required field.')], new Set(['other_select']), { ...LABELS, type: 'Type' });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});
