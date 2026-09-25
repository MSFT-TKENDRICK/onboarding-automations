// `verify`: a read-only proof of the live-portal assumptions the driver depends on (PORTAL.md, A1-A6).
// Every check fails closed: a check that could not run is pass:null, and only pass===true counts.
import { SLOTS, CANON, AMOUNT, normLabel } from './resolve.mjs';
import { validatorLabel, validatorProof } from './drift.mjs';
import { matchOption } from './match.mjs';

export const CHECK_IDS = ['portal_user', 'allowance_labels', 'field_ids', 'validators', 'timezone_default', 'writes_blocked'];

const real = (options = []) => options.filter((o) => o.value !== '' && o.value != null);
const check = (id, pass, evidence, detail) => ({ id, pass, evidence, detail });
// false beats null beats true: one refutation refutes; anything unchecked leaves the check unproven.
const combine = (passes) => (passes.includes(false) ? false : !passes.length || passes.includes(null) ? null : true);

export function maskIdentity(s) {
  if (s == null || s === '') return s ?? null;
  const [local, ...rest] = String(s).split('@');
  const masked = local.slice(0, 2) + '*'.repeat(Math.max(0, local.length - 2));
  return rest.length ? `${masked}@${rest.join('@')}` : masked;
}

// The amount a Monthly Allowance label states, or null. The label alone counts: a numeric value behind an
// unreadable label is exactly the drift A2 must catch.
export function labelAmount(label) {
  const l = String(label ?? '').trim();
  if (!l || !AMOUNT.test(l)) return null;
  const m = l.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// The standard (non-DST) UTC offset of an IANA zone as "+hh:mm", or null for a name Intl does not know.
export function standardOffset(zone) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }); } catch { return null; }
  const y = new Date().getUTCFullYear();
  const minutes = (d) => {
    const n = fmt.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = n.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);
    if (!m) return null;
    return m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  };
  const both = [minutes(new Date(Date.UTC(y, 0, 1))), minutes(new Date(Date.UTC(y, 6, 1)))];
  if (both.includes(null)) return null;
  const min = Math.min(...both);
  const a = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const labelOffset = (label) => {
  const m = String(label ?? '').trim().match(/^\(UTC(?:\s*([+-]\d{2}:\d{2}))?\)/i);
  return m ? (m[1] ?? '+00:00') : null;
};

// A1: Portal.User exposes the signed-in user, and the owner default bound exactly that user on the page.
export function checkPortalUser(scenarios) {
  const u = scenarios.find((s) => s.user?.present)?.user ?? scenarios.find((s) => s.user)?.user ?? { present: false };
  const identity = u.email || u.userName || null;
  const used = u.email ? 'email' : u.userName ? 'userName' : null;
  const reached = scenarios.filter((s) => s.owner?.reached);
  const bound = !!identity && reached.some((s) => s.owner.defaulted && String(s.owner.upn ?? '').toLowerCase() === identity.toLowerCase() && s.owner.guid);
  const shown = reached.find((s) => s.owner.defaulted)?.owner ?? reached[0]?.owner;
  const evidence = {
    present: !!identity, email: maskIdentity(u.email ?? null), userName: maskIdentity(u.userName ?? null), used,
    owner: { bound, reached: reached.length, defaulted: !!shown?.defaulted, upn: maskIdentity(shown?.upn ?? null), guid: !!shown?.guid },
  };
  if (!identity) return check('portal_user', false, evidence, 'Microsoft.Dynamic365.Portal.User exposes neither email nor userName, so the owner cannot default.');
  if (!reached.length) return check('portal_user', null, evidence, 'The owner step never ran (an earlier field failed), so the owner default is unproven.');
  return check('portal_user', bound, evidence, bound
    ? `Portal.User.${used} is present and the owner default bound to it (a resolved GUID).`
    : 'Portal.User is present but the owner default did not bind to that user with a resolved GUID.');
}

// A2: every Monthly Allowance label parses to an amount, the highest is unique, and the page holds it by default.
export function checkAllowance(scenarios) {
  const seen = scenarios.filter((s) => s.allowance);
  if (!seen.length) return check('allowance_labels', null, { scenarios: [] }, 'No scenario showed Monthly Allowance.');
  const rows = seen.map((s) => {
    const opts = real(s.allowance.options);
    const amounts = opts.map((o) => labelAmount(o.label));
    const parsed = amounts.filter((n) => n != null);
    const max = parsed.length ? Math.max(...parsed) : null;
    const top = opts.filter((_, i) => amounts[i] === max);
    const allParsed = opts.length > 0 && parsed.length === opts.length;
    const unique = top.length === 1;
    const chosen = allParsed && unique ? top[0] : null;
    const pass = !!chosen && s.allowance.defaulted === true && String(s.allowance.selected) === String(chosen.value);
    return { scenario: s.name, labels: opts.map((o) => o.label), amounts, max, maxCount: top.length, chosen: chosen?.label ?? null, selected: s.allowance.selected ?? null, defaulted: !!s.allowance.defaulted, pass };
  });
  const pass = rows.every((r) => r.pass);
  const bad = rows.find((r) => !r.pass);
  return check('allowance_labels', pass, { scenarios: rows }, pass ? 'Every allowance label parses and the unique maximum was selected by default.'
    : bad.amounts.includes(null) ? `Unparsable allowance label(s): ${bad.labels.filter((_, i) => bad.amounts[i] == null).map((l) => JSON.stringify(l)).join(', ')}.`
      : bad.maxCount !== 1 ? `The highest allowance (${bad.max}) is offered ${bad.maxCount} times.`
        : 'The page did not hold the highest allowance after defaulting.');
}

const allSlots = Object.keys(SLOTS);
const checkedSlots = (scenarios) => allSlots.filter((k) => scenarios.some((s) => s.applies?.includes(k) && s.slots?.[k]));

// A3: each slot is bound by its expected id, the id is unique, and its associated label is the canonical one.
export function checkFieldIds(scenarios) {
  const slots = {};
  const problems = (r, k) => [
    r.tier !== 'id' && `bound via ${r.tier}`,
    r.id !== r.expectedId && `id ${JSON.stringify(r.id)} is not ${JSON.stringify(r.expectedId)}`,
    normLabel(r.label) !== normLabel(CANON[k]) && `label ${JSON.stringify(r.label)} is not ${JSON.stringify(CANON[k])}`,
    r.count !== 1 && `${r.count ?? 0} elements carry the id`,
    r.associated !== true && 'the label is not associated with the control',
  ].filter(Boolean);
  for (const k of checkedSlots(scenarios)) {
    const recs = scenarios.filter((s) => s.applies.includes(k) && s.slots[k]).map((s) => ({ s, r: s.slots[k], p: problems(s.slots[k], k) }));
    const shown = recs.find((x) => x.p.length) ?? recs[0];
    const { r } = shown;
    slots[k] = { expectedId: r.expectedId, id: r.id ?? null, label: r.label ?? null, canonical: CANON[k], tier: r.tier, pass: !shown.p.length, scenarios: recs.map((x) => x.s.name) };
    if (shown.p.length) Object.assign(slots[k], { count: r.count ?? 0, associated: !!r.associated, problems: shown.p, failedIn: shown.s.name });
  }
  const unchecked = allSlots.filter((k) => !slots[k]);
  const pass = combine([...Object.values(slots).map((x) => x.pass), ...unchecked.map(() => null)]);
  const failed = Object.keys(slots).filter((k) => !slots[k].pass);
  return check('field_ids', pass, { slots, unchecked }, pass === true ? 'Every slot is at its expected id with its canonical label.'
    : pass === false ? `Drifted: ${failed.map((k) => `${k} (${slots[k].problems.join('; ')})`).join(', ')}.`
      : `Not checked: ${unchecked.join(', ')} (no scenario showed them; run verify without --purpose/--type).`);
}

// A4: the enabled Page_Validators name each slot's canonical label and point at its expected id, and the
// driver's own proof (validatorProof) agrees.
export function checkValidators(scenarios) {
  const slots = {};
  for (const k of checkedSlots(scenarios)) {
    const recs = scenarios.filter((s) => s.applies.includes(k) && s.slots[k]).map((s) => {
      const expectedId = s.slots[k].expectedId;
      const vals = s.validators ?? [];
      const naming = vals.filter((v) => validatorLabel(v.message, CANON[k], { anchored: true }));
      const own = naming.filter((v) => v.enabled !== false);
      const independent = own.length > 0 && own.every((v) => v.control === expectedId);
      const p = validatorProof(k, vals, new Set([expectedId]), CANON);
      const proof = p.ok ? { ok: true, id: p.id } : { ok: false, reason: p.reason };
      return { s, expectedId, messages: naming.map((v) => v.message), controls: [...new Set(naming.map((v) => v.control))], enabled: own.length, proof, pass: independent && p.ok && p.id === expectedId };
    });
    const x = recs.find((r) => !r.pass) ?? recs[0];
    slots[k] = { expectedId: x.expectedId, messages: x.messages, controls: x.controls, enabled: x.enabled, proof: x.proof, pass: x.pass, scenarios: recs.map((r) => r.s.name) };
    if (!x.pass) slots[k].failedIn = x.s.name;
  }
  const unchecked = allSlots.filter((k) => !slots[k]);
  const pass = combine([...Object.values(slots).map((v) => v.pass), ...unchecked.map(() => null)]);
  const failed = Object.keys(slots).filter((k) => !slots[k].pass);
  return check('validators', pass, { slots, unchecked }, pass === true ? 'Every slot has an enabled validator naming its label on its expected id.'
    : pass === false ? `No proof for: ${failed.map((k) => `${k} (${slots[k].proof.reason ?? (slots[k].enabled ? `points at ${slots[k].controls.join(', ')}` : 'no enabled validator')})`).join(', ')}.`
      : `Not checked: ${unchecked.join(', ')}.`);
}

// A5: the default time zone matches exactly one option, the page holds it, and its UTC offset agrees.
export function checkTimezone(scenarios) {
  const seen = scenarios.filter((s) => s.timezone);
  const rows = seen.map((s) => {
    const t = s.timezone;
    const base = { scenario: s.name, zone: t.zone ?? null, source: t.source ?? null, ...(t.os !== undefined ? { os: t.os } : {}) };
    if (!t.zone) return { ...base, pass: null };
    const r = matchOption(t.options ?? [], t.zone, { kind: 'timezone' });
    const matched = r.ok ? { value: r.value, label: r.label } : null;
    const offset = standardOffset(t.zone);
    const lo = matched ? labelOffset(matched.label) : null;
    const offsetAgrees = offset && lo ? offset === lo : null;
    const pass = !!matched && t.defaulted === true && String(t.selected) === String(matched.value) && offsetAgrees !== false;
    return { ...base, matched, candidates: r.ok ? [r.label] : r.candidates ?? [], error: r.ok ? undefined : r.error, selected: t.selected ?? null, defaulted: !!t.defaulted, offset, offsetAgrees, pass };
  });
  const pass = rows.length ? combine(rows.map((r) => r.pass)) : null;
  const bad = rows.find((r) => r.pass === false);
  return check('timezone_default', pass, { scenarios: rows }, !rows.length ? 'No scenario showed Time Zone.'
    : pass === true ? 'The default zone matched exactly one option and the page selected it.'
      : pass === null ? 'No default time zone is known (set MCAPS_TIMEZONE or fix the OS zone).'
        : !bad.matched ? `${bad.zone} matched ${bad.candidates.length ? `${bad.candidates.length} options` : 'no option'} (${bad.error}).`
          : bad.offsetAgrees === false ? `${bad.zone} (${bad.offset}) matched ${JSON.stringify(bad.matched.label)}, whose offset disagrees.`
            : 'The page did not hold the matched zone after defaulting.');
}

// A6: while filling, no portal write got through. Sign-in writes are allowed only while the form loads.
export function checkWrites({ fillReached, submitsSent = 0, everArmed = false, decisions = [], witness = [] } = {}) {
  const blocked = {};
  const allowed = {};
  const violations = [];
  let portalAllowedOutsideSignIn = 0;
  for (const d of decisions) {
    if (d.action === 'fail') { blocked[d.method] = (blocked[d.method] ?? 0) + 1; continue; }
    (allowed[d.method] ??= {})[d.reason] = (allowed[d.method][d.reason] ?? 0) + 1;
    const where = `${d.method} ${d.host}${d.path} (${d.reason}, ${d.phase ?? 'no phase'})`;
    if (d.portal && !(d.reason === 'auth' && d.phase === 'load')) { portalAllowedOutsideSignIn++; violations.push(`portal write allowed outside sign-in: ${where}`); }
    else if (d.reason !== 'auth' && d.reason !== 'identity') violations.push(`write allowed without a sign-in reason: ${where}`);
  }
  if (submitsSent) violations.push(`${submitsSent} submit(s) sent`);
  if (everArmed) violations.push('the submit gate was armed');
  const byRef = new Map(decisions.filter((d) => d.ref).map((d) => [d.ref, d]));
  let uncorrelated = 0;
  for (const e of witness) {
    const d = (e.ref && byRef.get(e.ref)) ?? decisions.find((x) => x.portal && x.method === e.method && x.path === e.path && x.phase === e.phase);
    if (!d) {
      uncorrelated++;
      if (e.responded) violations.push(`the network saw ${e.method} ${e.path} answered with no guard decision (${e.phase ?? 'no phase'})`);
    } else if (e.responded && d.action === 'fail') violations.push(`the network saw ${e.method} ${e.path} answered although the guard blocked it`);
  }
  const evidence = {
    blocked, allowed, portalAllowedOutsideSignIn,
    witness: { observed: witness.length, responded: witness.filter((e) => e.responded).length, blockedByClient: witness.filter((e) => e.blocked).length, uncorrelated },
    submitsSent, everArmed, violations,
  };
  if (!fillReached) return check('writes_blocked', null, evidence, 'Filling never started, so no fill-time write was exercised.');
  const pass = violations.length === 0;
  const n = Object.values(blocked).reduce((a, b) => a + b, 0);
  return check('writes_blocked', pass, evidence, pass ? `No portal write got through while filling (${n} blocked).` : violations.join('; '));
}

export function verdict(checks) {
  return CHECK_IDS.every((id) => checks.filter((c) => c.id === id).length === 1) && checks.length === CHECK_IDS.length && checks.every((c) => c.pass === true);
}
