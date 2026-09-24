// Deterministic field resolution: maps each logical input (slot) to a live form control.
// Pure functions over snapshotFields() output. Fail closed: a slot is bound automatically only when its
// expected id still checks out or it was purely renamed; anything else is reported (with at most a suggestion)
// for the user to confirm with --map.
import { sha256, stableStringify } from './plan-store.mjs';
import { validatorProof } from './drift.mjs';

export const normLabel = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s*:]+$/, '').toLowerCase();
const real = (f) => (f.options ?? []).filter((o) => o.value !== '' && o.value != null);
const AMOUNT = /^(?:usd|eur|gbp|[$€£])?\s*\d{1,3}(?:,?\d{3})*(?:\.\d+)?\s*(?:usd|eur|gbp)?\s*(?:\/\s*month|per month|monthly)?$/i;

// kind: 'choice' (select or radio group), 'text' (text input or textarea), 'lookup' (people-picker text input).
// renamable/mappable false: never healed or remapped (owner: its hidden companions are id-bound).
export const SLOTS = {
  title: { kind: 'text', labels: ['Title'], re: (l) => /\btitle\b/.test(l) },
  purpose: { kind: 'choice', labels: ['Subscription Purpose'], re: (l) => /purpose/.test(l) },
  type: {
    kind: 'choice', labels: ['Subscription Type'], re: (l) => /\btype\b/.test(l) && !/tenant/.test(l),
    sig: (f) => { const ls = real(f).map((o) => normLabel(o.label)); return ls.some((l) => /internal/.test(l)) && ls.some((l) => /external/.test(l)); },
  },
  owner: { kind: 'lookup', labels: ['Subscription Owner'], re: (l) => /owner/.test(l), renamable: false, mappable: false },
  allowance: {
    kind: 'choice', labels: ['Monthly Allowance'], re: (l) => /allowance|monthly|spend|budget/.test(l),
    sig: (f) => { const o = real(f); return o.length > 0 && o.every((x) => AMOUNT.test(String(x.label ?? '').trim())); },
  },
  timezone: {
    kind: 'choice', labels: ['Time Zone'], re: (l) => /time ?zone/.test(l),
    sig: (f) => { const o = real(f); return o.length > 0 && o.filter((x) => /^\(utc/i.test(String(x.label ?? '').trim())).length / o.length >= 0.8; },
  },
  tenantType: { kind: 'choice', labels: ['Tenant Type'], re: (l) => /tenant/.test(l) && /type/.test(l) },
  tenantLicensing: { kind: 'choice', labels: ['Tenant Licensing'], re: (l) => /licens/.test(l) },
  tenantName: { kind: 'text', labels: ['Tenant Display Name'], re: (l) => /tenant/.test(l) && /name/.test(l) },
};

export const isChoiceField = (f) => f.tag === 'select' || f.type === 'radio';
// The canonical (live) label of every slot: what the portal's own validator messages start with.
export const CANON = Object.fromEntries(Object.entries(SLOTS).map(([k, s]) => [k, s.labels[0]]));
export function kindOk(kind, f) {
  if (kind === 'choice') return isChoiceField(f);
  if (kind === 'text') return (f.tag === 'input' && f.type === 'text') || f.tag === 'textarea';
  return f.tag === 'input' && f.type === 'text';
}

// Identity of a control: everything that defines what it is, nothing that the user sets. Option order is ignored.
export function fingerprint(f) {
  const key = (o) => `${o[0]}\u0000${o[1]}`;
  const options = (f.options ?? []).map((o) => [String(o.value ?? ''), String(o.label ?? '')]).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return sha256(stableStringify({ tag: f.tag ?? null, type: f.type ?? null, name: f.name ?? null, label: f.label ?? '', readonly: !!f.readonly, options }));
}

// Id tokens without the publisher prefix (desitsm_, apitil_, ...).
const idTokens = (id) => String(id ?? '').toLowerCase().replace(/^[a-z]+_/, '').split(/[_-]+/).filter(Boolean);
const idOverlap = (a, b) => { const B = idTokens(b); return idTokens(a).some((t) => B.some((u) => t === u || (Math.min(t.length, u.length) >= 5 && (t.includes(u) || u.includes(t))))); };

const SUGGEST_MIN = 3;

// validators: validatorIndex() output, enabling the validator proof. reserved: ids that are never a legal candidate
// (other slots' expected ids, id-bound companions, other --map targets).
export function resolveSlot(key, expectedId, fields, { claimed = new Set(), mapped, optional = false, applicable = false, given = false, validators, reserved = new Set() } = {}) {
  const spec = SLOTS[key];
  if (!spec) throw new Error(`unknown slot ${key}`);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const sigOk = (f) => !spec.sig || spec.sig(f);
  const usable = (f) => f.visible && !claimed.has(f.id) && kindOk(spec.kind, f) && !f.readonly;
  const hit = (f, via) => ({ ok: true, slot: key, id: f.id, via, field: f });

  if (mapped !== undefined) {
    const bad = (reason) => ({ ok: false, code: 'invalid_mapping', slot: key, id: mapped, reason });
    if (spec.mappable === false) return bad('not_mappable');
    const f = byId.get(mapped);
    if (!f) return bad('not_found');
    if (!f.visible) return bad('hidden');
    if (claimed.has(f.id)) return bad('claimed');
    if (!kindOk(spec.kind, f)) return bad('kind');
    if (f.readonly) return bad('readonly');
    if (!sigOk(f)) return bad('signature');
    return hit(f, 'mapped');
  }

  const expected = byId.get(expectedId);
  // An empty label is no evidence the control is still this slot, so it counts as drift.
  if (expected && usable(expected) && spec.re(normLabel(expected.label)) && sigOk(expected)) return hit(expected, 'id');

  if (spec.renamable !== false) {
    const canon = new Set(spec.labels.map(normLabel));
    const exact = fields.filter((f) => usable(f) && canon.has(normLabel(f.label)));
    if (exact.length === 1 && sigOk(exact[0]) && !fields.some((f) => f !== exact[0] && f.visible && spec.re(normLabel(f.label)))) return hit(exact[0], 'renamed');
  }

  const scored = fields.filter(usable).map((f) => {
    const evidence = [];
    if (spec.re(normLabel(f.label))) evidence.push('label');
    if (spec.sig && spec.sig(f)) evidence.push('signature');
    const score = evidence.length * 3 + (idOverlap(f.id, expectedId) ? 1 : 0);
    if (idOverlap(f.id, expectedId)) evidence.push('id');
    return { id: f.id, label: f.label, score, evidence };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  // A hidden expected dependent the selected type should show may have been replaced by a new control: drift.
  if (expected && !expected.visible && !(optional && applicable)) return { ok: false, code: 'not_shown', slot: key, expectedId };
  if (!expected && optional && !applicable && !given && !(scored[0]?.score >= SUGGEST_MIN)) return { ok: false, code: 'not_shown', slot: key, expectedId };

  const labelOf = expected ? { label: expected.label } : {};
  // Legal candidates: every control this slot could be bound to (the same checks --map applies), nothing reserved.
  const scoreOf = new Map(scored.map((c) => [c.id, c.score]));
  const legal = fields.filter((f) => usable(f) && sigOk(f) && !reserved.has(f.id))
    .sort((a, b) => (scoreOf.get(b.id) ?? 0) - (scoreOf.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1));
  // Absent: the expected id is gone and nothing legal or even similar remains (a changed control is drift, not absent).
  if (!legal.length && !expected && !scored.length) return { ok: false, code: 'field_absent', slot: key, expectedId };
  // Proofs authorize: page validators that name this slot's canonical label for exactly one legal control.
  if (validators && legal.length && spec.renamable !== false && spec.mappable !== false) {
    const proof = validatorProof(key, validators, new Set(legal.map((f) => f.id)), CANON);
    if (proof.ok) return { ...hit(byId.get(proof.id), 'validator'), evidence: proof.evidence };
  }

  const [best, second] = scored;
  const suggest = spec.mappable !== false && best && best.score >= SUGGEST_MIN && best.score - (second?.score ?? 0) >= 1;
  return {
    ok: false, code: 'field_drift', slot: key, expectedId,
    ...labelOf,
    ...(suggest ? { suggested: { id: best.id, label: best.label, evidence: best.evidence } } : {}),
    candidates: scored.slice(0, 5).map(({ id, label, score }) => ({ id, label, score })),
    pool: legal.map((f) => f.id),
  };
}

// Syntax-level checks on --map before the browser starts. `expected`: slot -> expected id; `reserved`: id-bound ids.
export function validateMap(map, { expected = {}, reserved = new Set() } = {}) {
  const errors = [];
  const out = {};
  if (map == null) return { ok: true, map: out };
  if (typeof map !== 'object' || Array.isArray(map)) return { ok: false, errors: ['map must be an object of slot -> field id'] };
  for (const [slot, raw] of Object.entries(map)) {
    const id = String(raw ?? '').trim();
    if (!SLOTS[slot]) { errors.push(`unknown slot "${slot}" (valid: ${Object.keys(SLOTS).filter((k) => SLOTS[k].mappable !== false).join(', ')})`); continue; }
    if (SLOTS[slot].mappable === false) { errors.push(`${slot} cannot be remapped`); continue; }
    if (!/^[A-Za-z_][\w-]{0,127}$/.test(id)) { errors.push(`${slot}: "${id}" is not a field id`); continue; }
    if (reserved.has(id)) { errors.push(`${slot}: ${id} is a derived field and cannot be mapped`); continue; }
    out[slot] = id;
  }
  const targets = Object.values(out);
  for (const [slot, id] of Object.entries(out)) {
    if (targets.filter((t) => t === id).length > 1) errors.push(`${id} is mapped to more than one slot`);
    // Another slot's own field is only available when that slot is explicitly mapped elsewhere (a swap).
    const owner = Object.keys(expected).find((k) => k !== slot && expected[k] === id);
    if (owner && !(owner in out && out[owner] !== id)) errors.push(`${slot}: ${id} is the ${owner} field; map ${owner} elsewhere first`);
  }
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, map: out };
}
