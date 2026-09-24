// CLI usage text and `next` hints. No browser: only paths that return before the portal is opened, plus nextHint.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, nextHint, HELP } from '../../skills/request-new-azure-subscription/scripts/mcaps-subscription.mjs';

describe('--help', () => {
  it('lists every command, groups flags, states defaults and gives examples', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.equal(r.out.usage, HELP);
    for (const s of ['plan', 'options', 'submit', 'status']) assert.match(HELP, new RegExp(`mcaps-subscription\\.mjs ${s}\\b`));
    for (const g of ['Inputs', 'Submit', 'Status', 'Common', 'Examples', 'Exit codes']) assert.match(HELP, new RegExp(`^${g}`, 'm'));
    for (const d of ['default internal', 'the signed-in user', 'the highest monthly allowance', 'MCAPS_TIMEZONE', '30 minutes']) assert.ok(HELP.includes(d), d);
  });

  it('documents every flag the parser accepts', () => {
    for (const f of ['title', 'purpose', 'type', 'owner', 'allowance', 'timezone', 'tenant-type', 'tenant-licensing', 'tenant-name', 'field', 'map', 'json', 'no-defaults', 'full-terms', 'plan', 'accept-terms', 'allow-duplicate', 'case', 'headed', 'ephemeral', 'browser', 'verbose', 'pretty', 'help']) {
      assert.ok(HELP.includes(`--${f}`), `--${f}`);
    }
  });

  it('never shows a ready-made submit command with a real sha', () => {
    assert.ok(!/--accept-terms [0-9a-f]{16,}/.test(HELP));
  });
});

describe('next hints on early errors (no browser)', () => {
  it('bad_args points at --help', async () => {
    const r = await run(['submit']);
    assert.equal(r.out.error, 'bad_args');
    assert.match(r.out.next, /--help/);
  });

  it('invalid_mapping never suggests guessing a control', async () => {
    const r = await run(['plan', '--map', 'owner=x']);
    assert.equal(r.out.error, 'invalid_mapping');
    assert.match(r.out.next, /--map/);
    assert.match(r.out.next, /approved/);
  });

  it('plan_invalid asks for a new plan and a new acceptance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcaps-cli-'));
    try {
      const r = await run(['submit', '--plan', 'a'.repeat(64), '--accept-terms', 'x'], { env: { MCAPS_SKILL_HOME: dir } });
      assert.equal(r.code, 1);
      assert.equal(r.out.error, 'plan_invalid');
      assert.match(r.out.next, /Re-run plan/);
      assert.match(r.out.next, /terms/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('nextHint', () => {
  const plan = (status, extra = {}) => nextHint('plan', { status, missing: [], errors: [], blockers: [], warnings: [], ...extra });

  it('ready plans: show terms, submit only after acceptance, never the sha itself', () => {
    const h = plan('ready', { planId: 'p1', terms: { sha: 'f'.repeat(64) } });
    assert.match(h, /full terms/);
    assert.match(h, /explicitly accept/);
    assert.match(h, /submit --plan p1 --accept-terms <terms\.sha>/);
    assert.ok(!h.includes('f'.repeat(64)));
    assert.match(plan('ready', { planId: 'p1', inferred: [{ field: 'timezone' }] }), /inferred/);
    assert.match(plan('ready', { planId: 'p1', defaulted: [{ field: 'type' }] }), /defaulted/);
    assert.match(plan('ready', { planId: 'p1', warnings: [{ code: 'possible_duplicate' }] }), /--allow-duplicate/);
  });

  it('needs_input: ask, never pick; drift needs the user\'s --map; absent stops', () => {
    assert.match(plan('needs_input', { missing: [{ field: 'purpose' }] }), /Ask the user/);
    const drift = plan('needs_input', { missing: [{ field: 'timezone', code: 'field_drift' }] });
    assert.match(drift, /--map timezone=<id>/);
    assert.match(drift, /only for the control the user picks/);
    assert.match(plan('needs_input', { missing: [{ field: 'timezone', code: 'field_absent' }] }), /skill needs an update/);
    assert.doesNotMatch(plan('needs_input', { missing: [{ field: 'purpose' }, { field: 'timezone', code: 'field_absent' }] }), /re-run plan/i);
    assert.match(plan('needs_input', { missing: [{ field: 'fields.x', code: 'unknown_required_field', id: 'x' }] }), /--field x=<value>/);
  });

  it('invalid: show candidates, the user picks', () => {
    const h = plan('invalid', { errors: [{ code: 'ambiguous_owner', field: 'owner' }] });
    assert.match(h, /candidates/);
    assert.match(h, /Never pick/);
    const unsupported = plan('invalid', { errors: [{ code: 'invalid_option' }, { code: 'unsupported_field' }] });
    assert.match(unsupported, /skill needs an update/);
    assert.doesNotMatch(unsupported, /re-run plan/i);
    assert.match(plan('invalid', { errors: [{ code: 'set_failed' }, { code: 'owner_not_bound' }] }), /Re-run plan once/);
  });

  it('blocked: report and stop', () => {
    assert.match(plan('blocked', { blockers: [{ code: 'active_request' }] }), /stop/);
  });

  it('submit outcomes', () => {
    assert.match(nextHint('submit', { outcome: 'success', caseId: 'REQ-000001-2026' }), /REQ-000001-2026/);
    assert.match(nextHint('submit', { outcome: 'rejected' }), /Nothing was created/);
    const u = nextHint('submit', { outcome: 'unknown', probableCaseId: 'REQ-000002-2026' });
    assert.match(u, /Do NOT resubmit/);
    assert.match(u, /status --case REQ-000002-2026/);
    assert.match(nextHint('submit', { outcome: 'unknown' }), /status/);
    for (const reason of ['plan_mismatch', 'form_changed', 'submit_body_mismatch', 'plan_no_longer_ready']) assert.match(nextHint('submit', { outcome: 'not_submitted', reason }), /Re-run plan/, reason);
    assert.match(nextHint('submit', { outcome: 'not_submitted', reason: 'duplicate_active' }), /--allow-duplicate/);
    assert.match(nextHint('submit', { outcome: 'not_submitted', reason: 'not_delivered' }), /terms again/);
    assert.match(nextHint('submit', { outcome: 'not_submitted', reason: 'submit_contract_changed' }), /stop/);
  });

  it('errors', () => {
    const e = (error, cmd = 'plan', extra = {}) => nextHint(cmd, { ok: false, error, ...extra });
    assert.match(e('auth_required'), /--headed/);
    assert.match(e('vpn_required'), /VPN/);
    assert.match(e('portal_unreachable'), /VPN/);
    assert.match(e('no_eligible_purpose'), /stop/);
    assert.match(e('non_microsoft_account'), /corporate account/);
    assert.match(e('terms_not_accepted', 'submit'), /full terms/);
    assert.match(e('already_submitted', 'submit'), /Do not retry/);
    assert.match(e('already_submitted', 'submit', { previous: { outcome: 'success' } }), /--allow-duplicate/);
    assert.match(e('portal_timeout'), /once/);
    assert.match(e('portal_timeout', 'submit'), /terms again/);
  });

  it('status --case not found: check later, never resubmit', () => {
    assert.match(nextHint('status', { ok: true, found: false, requests: [] }), /never resubmit/i);
    assert.equal(nextHint('status', { ok: true, requests: [] }), undefined);
    assert.equal(nextHint('options', { ok: true, status: 'needs_input' }), undefined);
  });
});
