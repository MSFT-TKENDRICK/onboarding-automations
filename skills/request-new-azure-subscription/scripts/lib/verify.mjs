// `verify`: a read-only proof of the live-portal assumptions the driver depends on (PORTAL.md, A1-A6).
// Every check fails closed: a check that could not run is pass:null, and only pass===true counts.
import { SLOTS, CANON, AMOUNT, normLabel } from './resolve.mjs';
import { validatorLabel, validatorProof } from './drift.mjs';
import { matchOption } from './match.mjs';
import { systemTimeZone } from './defaults.mjs';
import { openForm, fill, normalizeInput, SLOT_ID, APPLIES, DEFAULT_FORM_URL, SkillError } from './portal.mjs';
import * as P from './page.mjs';

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

// A1: Portal.User exposes the signed-in user, and in every scenario that reached the owner step the owner default
// bound exactly that user. A scenario that was expected to reach it and did not leaves the check unproven (null).
export function checkPortalUser(scenarios) {
  const idOf = (u) => u?.email || u?.userName || null;
  const rows = [];
  for (const s of scenarios) {
    const u = s.user ?? { present: false };
    const identity = idOf(u);
    const o = s.owner ?? {};
    const base = { scenario: s.name, present: !!identity, reached: !!o.reached };
    if (!identity) { rows.push({ ...base, s, bound: false, pass: false, why: 'no identity' }); continue; }
    if (!o.reached) { if (expects(s, 'owner')) rows.push({ ...base, s, bound: false, pass: null, why: 'not reached' }); continue; }
    const bound = !!o.defaulted && String(o.upn ?? '').toLowerCase() === identity.toLowerCase() && !!o.guid;
    rows.push({ ...base, s, bound, pass: bound, why: bound ? null : 'not bound' });
  }
  const shownRow = rows.find((r) => r.pass === false) ?? rows.find((r) => r.pass === null) ?? rows[0];
  const u = shownRow?.s.user ?? scenarios[0]?.user ?? { present: false };
  const identity = idOf(u);
  const used = u.email ? 'email' : u.userName ? 'userName' : null;
  const reached = rows.filter((r) => r.reached);
  const shown = (shownRow?.reached ? shownRow.s.owner : reached[0]?.s.owner) ?? null;
  const pass = rows.length ? combine(rows.map((r) => r.pass)) : null;
  const evidence = {
    present: !!identity, email: maskIdentity(u.email ?? null), userName: maskIdentity(u.userName ?? null), used,
    owner: { bound: pass === true, reached: reached.length, defaulted: !!shown?.defaulted, upn: maskIdentity(shown?.upn ?? null), guid: !!shown?.guid },
    scenarios: rows.map(({ scenario, present, reached: r, bound, pass: p }) => ({ scenario, present, reached: r, bound, pass: p })),
  };
  const names = (why) => rows.filter((r) => r.why === why).map((r) => r.scenario).join(', ');
  if (pass === true) return check('portal_user', true, evidence, `Portal.User.${used} is present and the owner default bound to it (a resolved GUID) in every scenario.`);
  if (pass === false) return check('portal_user', false, evidence, names('no identity')
    ? `Microsoft.Dynamic365.Portal.User exposes neither email nor userName (in ${names('no identity')}), so the owner cannot default.`
    : `Portal.User is present but the owner default did not bind to that user with a resolved GUID (in ${names('not bound')}).`);
  return check('portal_user', null, evidence, `The owner step never ran${names('not reached') ? ` in ${names('not reached')}` : ''} (an earlier field failed), so the owner default is unproven.`);
}

// A2: every Monthly Allowance label parses to an amount, the highest is unique, and the page holds it by default.
export function checkAllowance(scenarios) {
  const seen = scenarios.filter((s) => s.allowance);
  const lost = scenarios.filter((s) => !s.allowance && expects(s, 'allowance')).map((s) => ({ scenario: s.name, pass: null, detail: 'Monthly Allowance was expected but never read' }));
  if (!seen.length && !lost.length) return check('allowance_labels', null, { scenarios: [] }, 'No scenario showed Monthly Allowance.');
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
  const all = [...rows, ...lost];
  const pass = combine(all.map((r) => r.pass));
  const bad = rows.find((r) => r.pass === false);
  return check('allowance_labels', pass, { scenarios: all }, pass === true ? 'Every allowance label parses and the unique maximum was selected by default.'
    : pass === null ? `Monthly Allowance was never read in ${lost.map((r) => r.scenario).join(', ')}, so its labels there are unproven.`
      : bad.amounts.includes(null) ? `Unparsable allowance label(s): ${bad.labels.filter((_, i) => bad.amounts[i] == null).map((l) => JSON.stringify(l)).join(', ')}.`
        : bad.maxCount !== 1 ? `The highest allowance (${bad.max}) is offered ${bad.maxCount} times.`
          : 'The page did not hold the highest allowance after defaulting.');
}

const allSlots = Object.keys(SLOTS);
const expects = (s, k) => (s.expected ?? s.applies ?? []).includes(k);
const covers = (s, k) => !!(s.applies?.includes(k) && s.slots?.[k]);
const checkedSlots = (scenarios) => allSlots.filter((k) => scenarios.some((s) => covers(s, k)));
const gapsFor = (scenarios, k) => scenarios.filter((s) => expects(s, k) && !covers(s, k)).map((s) => s.name);
const slotPass = (failed, gaps) => (failed ? false : gaps.length ? null : true);
const notProven = (slots, unchecked) => [
  ...Object.entries(slots).filter(([, x]) => x.pass === null).map(([k, x]) => `${k} (never bound in ${x.unverifiedIn.join(', ')})`),
  ...unchecked,
].join(', ');

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
    const recs = scenarios.filter((s) => covers(s, k)).map((s) => ({ s, r: s.slots[k], p: problems(s.slots[k], k) }));
    const shown = recs.find((x) => x.p.length) ?? recs[0];
    const { r } = shown;
    const gaps = gapsFor(scenarios, k);
    slots[k] = { expectedId: r.expectedId, id: r.id ?? null, label: r.label ?? null, canonical: CANON[k], tier: r.tier, pass: slotPass(shown.p.length > 0, gaps), scenarios: recs.map((x) => x.s.name) };
    if (gaps.length) slots[k].unverifiedIn = gaps;
    if (shown.p.length) Object.assign(slots[k], { count: r.count ?? 0, associated: !!r.associated, problems: shown.p, failedIn: shown.s.name });
  }
  const unchecked = allSlots.filter((k) => !slots[k]);
  const pass = combine([...Object.values(slots).map((x) => x.pass), ...unchecked.map(() => null)]);
  const failed = Object.keys(slots).filter((k) => slots[k].pass === false);
  return check('field_ids', pass, { slots, unchecked }, pass === true ? 'Every slot is at its expected id with its canonical label.'
    : pass === false ? `Drifted: ${failed.map((k) => `${k} (${slots[k].problems.join('; ')})`).join(', ')}.`
      : `Not proven: ${notProven(slots, unchecked)} (no scenario showed them there; run verify without --purpose/--type).`);
}

// A4: the enabled Page_Validators name each slot's canonical label and point at its expected id, and the
// driver's own proof (validatorProof) agrees.
export function checkValidators(scenarios) {
  const slots = {};
  for (const k of checkedSlots(scenarios)) {
    const recs = scenarios.filter((s) => covers(s, k)).map((s) => {
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
    const gaps = gapsFor(scenarios, k);
    slots[k] = { expectedId: x.expectedId, messages: x.messages, controls: x.controls, enabled: x.enabled, proof: x.proof, pass: slotPass(!x.pass, gaps), scenarios: recs.map((r) => r.s.name) };
    if (gaps.length) slots[k].unverifiedIn = gaps;
    if (!x.pass) slots[k].failedIn = x.s.name;
  }
  const unchecked = allSlots.filter((k) => !slots[k]);
  const pass = combine([...Object.values(slots).map((v) => v.pass), ...unchecked.map(() => null)]);
  const failed = Object.keys(slots).filter((k) => slots[k].pass === false);
  return check('validators', pass, { slots, unchecked }, pass === true ? 'Every slot has an enabled validator naming its label on its expected id.'
    : pass === false ? `No proof for: ${failed.map((k) => `${k} (${slots[k].proof.reason ?? (slots[k].enabled ? `points at ${slots[k].controls.join(', ')}` : 'no enabled validator')})`).join(', ')}.`
      : `Not proven: ${notProven(slots, unchecked)}.`);
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
  const lost = scenarios.filter((s) => !s.timezone && expects(s, 'timezone')).map((s) => ({ scenario: s.name, pass: null, detail: 'Time Zone was expected but never read' }));
  rows.push(...lost);
  const pass = rows.length ? combine(rows.map((r) => r.pass)) : null;
  const bad = rows.find((r) => r.pass === false);
  return check('timezone_default', pass, { scenarios: rows }, !rows.length ? 'No scenario showed Time Zone.'
    : pass === true ? 'The default zone matched exactly one option and the page selected it.'
      : pass === null ? (lost.length ? `Time Zone was never read in ${lost.map((r) => r.scenario).join(', ')}.` : 'No default time zone is known (set MCAPS_TIMEZONE or fix the OS zone).')
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

// A --purpose/--type run exercises only part of the form: field_ids and validators can refute there, never prove.
export function narrowToScope(checks, { purpose, type } = {}) {
  if (purpose === undefined && !type) return checks;
  const scope = [purpose !== undefined && '--purpose', type && '--type'].filter(Boolean).join('/');
  return checks.map((c) => (['field_ids', 'validators'].includes(c.id) && c.pass === true
    ? { ...c, pass: null, detail: `Scoped run (${scope}): other purposes or types were not exercised, so this is unproven. ${c.detail}` }
    : c));
}

// ---------------------------------------------------------------- orchestration (browser)
const COMMON = ['title', 'purpose', 'type', 'owner'];
const TYPES = ['internal', 'external'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const byId = (fields) => Object.fromEntries(fields.map((f) => [f.id, f]));

// The live portal, exactly: the built-in form URL, and every page the run evaluated on its origin, path and ServiceId.
export function isLivePortal(formUrl, pages) {
  const want = new URL(DEFAULT_FORM_URL);
  const same = (u) => { try { const x = new URL(u); return x.origin === want.origin && x.pathname.toLowerCase() === want.pathname.toLowerCase() && x.searchParams.get('ServiceId') === want.searchParams.get('ServiceId'); } catch { return false; } };
  return formUrl === DEFAULT_FORM_URL && pages.length > 0 && pages.every(same);
}

// One read-only pass over every offered purpose x type (or the --purpose/--type subset): fill with defaults on and
// every write blocked, then read the page's own evidence. Never saves a plan, never arms or sends a submit.
export async function runVerify(s, { purpose, type, env = process.env } = {}) {
  const t0 = performance.now();
  s.hooks.onSubmit = () => { throw new Error('verify never submits'); };
  const zone = systemTimeZone(env);
  const source = env.MCAPS_TIMEZONE ? 'MCAPS_TIMEZONE' : 'os';
  const os = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  const call = (fn, ...a) => s.page.call(fn, ...a);

  s.guard.setPhase('load');
  await openForm(s);
  const st = await s.state();
  const purposeField = (await call(P.snapshotFields)).find((f) => f.id === (st?.purposeId ?? SLOT_ID.purpose));
  const offered = real(purposeField?.options);
  let purposes = offered;
  if (purpose !== undefined) {
    const m = matchOption(offered, purpose);
    if (!m.ok) throw new SkillError('bad_args', `--purpose "${purpose}" matches ${m.error === 'ambiguous' ? 'several' : 'no'} offered purpose. Offered: ${offered.map((o) => o.label).join(' | ')}`);
    purposes = [{ value: m.value, label: m.label }];
  }
  const types = type ? [type] : TYPES;

  const records = [];
  const summaries = [];
  const pages = [];
  let fillReached = false;
  let fresh = true;
  for (const p of purposes) {
    for (const t of types) {
      if (!fresh) { s.guard.setPhase('load'); await openForm(s); }
      fresh = false;
      const user = await call(P.portalUser);
      s.guard.setPhase('fill');
      fillReached = true;
      const r = await fill(s, normalizeInput({ purpose: p.value, type: t }), { defaults: true, discover: false, timeZone: zone, systemOne: null });
      const snap = byId(await call(P.snapshotFields));
      const validators = await call(P.validatorIndex);
      const pageUrl = (await s.state())?.url ?? null;
      if (pageUrl) pages.push(pageUrl);
      const b = r.bindings ?? {};
      const boundId = (k) => (b[k]?.ok ? b[k].id : null);
      const typeShown = !!r.resolved.type && new RegExp(t, 'i').test(r.resolved.type.label ?? '');
      const typeField = snap[boundId('type') ?? SLOT_ID.type];
      const typeOffered = real(typeField?.options).some((o) => new RegExp(t, 'i').test(o.label ?? ''));
      const applies = [...COMMON, ...(typeShown ? APPLIES[t] : [])].filter((k) => b[k]);
      // What this scenario had to cover: a type the purpose really does not offer is recorded, never a silent gap.
      const expected = typeOffered ? [...COMMON, ...APPLIES[t]] : COMMON.filter((k) => k !== 'type' || b[k]);
      const ev = await call(P.controlEvidence, applies.map((k) => boundId(k) ?? SLOT_ID[k]));
      const slots = Object.fromEntries(applies.map((k) => {
        const id = boundId(k);
        const e = ev[id ?? SLOT_ID[k]] ?? {};
        return [k, { expectedId: SLOT_ID[k], id, label: e.label ?? snap[id ?? SLOT_ID[k]]?.label ?? null, tier: b[k].tier, count: e.count ?? 0, associated: !!e.associated }];
      }));
      const defaulted = (k) => r.defaulted.some((d) => d.field === k);
      const choice = (k) => {
        if (!applies.includes(k)) return null;
        const id = boundId(k) ?? (snap[SLOT_ID[k]] ? SLOT_ID[k] : null);
        return id ? { id, options: snap[id]?.options ?? [], selected: snap[id]?.value ?? null, defaulted: defaulted(k) } : null;
      };
      const tz = choice('timezone');
      const name = `${p.label}/${t}`;
      records.push({
        name, type: t, pageUrl, expected, applies, slots, validators,
        user: { present: !!(user.email || user.userName), email: user.email, userName: user.userName },
        owner: { reached: !!b.owner, defaulted: defaulted('owner'), upn: r.resolved.owner?.upn ?? null, guid: GUID.test(r.derived?.ownerGuid ?? '') },
        allowance: choice('allowance'),
        timezone: tz && { ...tz, zone, source, os },
      });
      const codes = (list) => (list ?? []).map((x) => x.code ?? x.field);
      summaries.push({ name, status: r.status, typeOffered, typeShown, expected, checked: applies, missing: codes(r.missing), errors: codes(r.errors), blockers: codes(r.blockers) });
      s.log(`verify ${name}: ${r.status}`);
    }
  }

  const g = s.guard.stats();
  const checks = narrowToScope([
    checkPortalUser(records), checkAllowance(records), checkFieldIds(records), checkValidators(records), checkTimezone(records),
    checkWrites({ fillReached, submitsSent: g.submitsSent + s.submitEvents.length, everArmed: g.everArmed, decisions: g.writes, witness: s.witness() }),
  ], { purpose, type });
  const uniquePages = [...new Set(pages)];
  return {
    ok: verdict(checks), checks,
    portal: { url: s.formUrl, live: isLivePortal(s.formUrl, uniquePages), pages: uniquePages },
    selections: { purposes: purposes.map((o) => o.label), types },
    scenarios: summaries,
    ms: Math.round(performance.now() - t0),
  };
}
