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
  it('needs the message to start with the label ("Job Title is required" is not Title evidence)', () => {
    const r = validatorProof('title', [v('job_title', 'Job Title is a required field.')], new Set(['job_title']), LABELS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_validator');
    assert.equal(validatorLabel('Please select a Time Zone', 'Time Zone', { anchored: true }), false);
    assert.equal(validatorLabel('  Time Zone is a required field.', 'Time Zone', { anchored: true }), true);
  });
  it('a disabled validator is no evidence, but still voids a proof that points elsewhere', () => {
    const off = (control, message) => ({ control, message, enabled: false });
    assert.equal(validatorProof('allowance', [off('new_spend', 'Monthly Allowance is required')], eligible, LABELS).reason, 'no_validator');
    const r = validatorProof('allowance', [v('new_spend', 'Monthly Allowance is required'), off('other_select', 'Monthly Allowance is required')], eligible, LABELS);
    assert.equal(r.reason, 'multiple_controls');
    const s = validatorProof('allowance', [v('new_spend', 'Monthly Allowance is required'), off('new_spend', 'Time Zone is required')], eligible, LABELS);
    assert.equal(s.reason, 'shared_control');
  });
  it('a mention of the label on another control (not at the start) voids the proof', () => {
    const r = validatorProof('allowance', [v('new_spend', 'Monthly Allowance is required'), v('other_select', 'Pick the Monthly Allowance first')], eligible, LABELS);
    assert.equal(r.reason, 'multiple_controls');
  });
  it('does not treat a longer label containing a shorter one as compound (Tenant Type vs Type)', () => {
    const r = validatorProof('tenantType', [v('other_select', 'Tenant Type is a required field.')], new Set(['other_select']), { ...LABELS, type: 'Type' });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe('validatorProof: live page context (F4 longer labels, F5 declared carrier)', () => {
  const L = { ...LABELS, owner: 'Subscription Owner' };
  const ctx = [['desitsm_subscriptionowner', 'Subscription Owner'], ['desitsm_secondarysubscriptionowner', 'Secondary Subscription Owner (FTE)'], ['desitsm_secondarysubscriptionownervalidationholde', 'Secondary Subscription Owner Validation Holder'], ['desitsm_primarysubscriptionownervalidationholder', 'Primary Subscription Owner Validation Holder'], ['desitsm_monthlyspend', 'Monthly Allowance']].map(([id, label]) => ({ id, label }));
  const owner = [
    v('desitsm_subscriptionowner', 'Subscription Owner is a required field.'),
    v('desitsm_subscriptionowner', 'Subscription Owner exceeds the maximum length of 100 characters.'),
    v('desitsm_secondarysubscriptionowner', 'Secondary Subscription Owner (FTE) exceeds the maximum length of 200 characters.'),
    v('desitsm_secondarysubscriptionownervalidationholde', 'Secondary Subscription Owner Validation Holder exceeds the maximum length of 100 characters.'),
    v('desitsm_primarysubscriptionownervalidationholder', 'Primary Subscription Owner Validation Holder exceeds the maximum length of 100 characters.'),
  ];
  const el = new Set(['desitsm_subscriptionowner', 'desitsm_secondarysubscriptionowner']);
  it('without page context, longer labels of other controls void the proof (live failure)', () => {
    assert.equal(validatorProof('owner', owner, el, L).reason, 'multiple_controls');
  });
  it('masks mentions that only fall inside a longer on-page label', () => {
    const r = validatorProof('owner', owner, el, L, { context: ctx });
    assert.equal(r.ok, true);
    assert.equal(r.id, 'desitsm_subscriptionowner');
  });
  it('a message that still names the slot label on its own is a mention (other control -> void)', () => {
    const r = validatorProof('owner', [...owner, v('desitsm_secondarysubscriptionowner', 'Secondary Subscription Owner (FTE) must differ from Subscription Owner.')], el, L, { context: ctx });
    assert.equal(r.reason, 'multiple_controls');
  });
  it('a context label that is not on the page as a longer label masks nothing', () => {
    const r = validatorProof('owner', [...owner, v('x', 'Subscription Owner must be chosen')], el, L, { context: [{ id: 'desitsm_subscriptionowner', label: 'Subscription Owner' }] });
    assert.equal(r.reason, 'multiple_controls');
  });
  it('a longer label that only contains the slot label as a partial word never masks', () => {
    const r = validatorProof('owner', [...owner.slice(0, 2), v('x', 'Subscription Ownership: Subscription Owner required')], el, L, { context: [{ id: 'x', label: 'Subscription Ownership' }] });
    assert.equal(r.reason, 'multiple_controls');
  });
  it('a longer label is masked only in validators on the control that carries it', () => {
    const r = validatorProof('owner', [...owner, v('desitsm_other', 'Secondary Subscription Owner (FTE) is invalid')], el, L, { context: ctx });
    assert.equal(r.reason, 'multiple_controls');
  });
  const allowance = [
    v('desitsm_monthlyspend', 'Monthly Allowance is a required field.'),
    v('desitsm_estimatedmonthlyspend', 'Monthly Allowance must have a value between -922,337,203,685,477.0000 and 922,337,203,685,477.0000.'),
  ];
  const ael = new Set(['desitsm_monthlyspend']);
  it('the allowance validators split across select and carrier void the proof without the declared alias', () => {
    assert.equal(validatorProof('allowance', allowance, ael, L).reason, 'multiple_controls');
  });
  it('the declared carrier alias treats the carrier as the select for that slot', () => {
    const r = validatorProof('allowance', allowance, ael, L, { aliases: { desitsm_estimatedmonthlyspend: 'desitsm_monthlyspend' } });
    assert.equal(r.ok, true);
    assert.equal(r.id, 'desitsm_monthlyspend');
  });
  it('an alias never rescues a third control or a carrier that names another slot', () => {
    const al = { desitsm_estimatedmonthlyspend: 'desitsm_monthlyspend' };
    assert.equal(validatorProof('allowance', [...allowance, v('other', 'Monthly Allowance is invalid')], ael, L, { aliases: al }).reason, 'multiple_controls');
    assert.equal(validatorProof('allowance', [...allowance, v('desitsm_estimatedmonthlyspend', 'Title is a required field.')], ael, L, { aliases: al }).reason, 'shared_control');
  });
});
