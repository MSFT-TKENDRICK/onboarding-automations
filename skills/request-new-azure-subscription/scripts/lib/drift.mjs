// Pure proofs for field drift. "Probabilities rank, proofs authorize": a remap is only
// authorized by page-owned evidence (ASP.NET Page_Validators), never by model confidence.
// Claim limit: page-owned evidence covers a portal that changed, not one that is actively hostile (a hostile
// page can forge validators just as it can forge ids and labels); the POST gate still pins what is sent.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// anchored: the message must start with the label, as the portal's own messages do ("<Label> is a required field.").
export function validatorLabel(message, label, { anchored = false } = {}) {
  const body = `${esc(label).replace(/\s+/g, '\\s+')}(?![\\w-])`;
  return new RegExp(anchored ? `^\\s*${body}` : `(?<![\\w-])${body}`, 'i').test(String(message ?? ''));
}

const phrase = (l) => new RegExp(`(?<![\\w-])${esc(l).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'gi');

// Labels that occur in the message on their own: occurrences that fall entirely inside a longer label (another slot's,
// or the longer label of the validator's own control from `extra`) are masked first, longest first.
function labelsIn(message, labels, extra = []) {
  const all = [...new Set([...Object.values(labels), ...extra].filter((l) => typeof l === 'string' && l.trim()))];
  return Object.entries(labels).filter(([, l]) => {
    let m = String(message ?? '');
    for (const o of all.filter((o) => o.length > l.length && validatorLabel(o, l)).sort((a, b) => b.length - a.length)) m = m.replace(phrase(o), ' ');
    return validatorLabel(m, l);
  }).map(([slot]) => slot);
}

// validators: [{control, message, enabled?}] from Page_Validators. eligible: Set of control ids.
// Evidence: enabled validators whose message starts with the slot's label. Every validator that mentions the label,
// enabled or not, must agree on the control; any compound or shared message voids the proof.
// context: [{id, label}] of the on-page controls. A validator's own control's (longer) label is masked in its message
// ("Secondary Subscription Owner (FTE) exceeds ..." on that control is not an owner mention); a longer label in a
// validator on any other control is never masked. aliases: {carrierId: controlId} for the slot's declared carrier pair
// only; the carrier's validators count as the control's own.
export function validatorProof(slot, validators, eligible, labels, { context = [], aliases = {} } = {}) {
  const ctl = (c) => (Object.hasOwn(aliases, c) ? aliases[c] : c);
  const own = (c) => context.filter((f) => f && f.id === c).map((f) => f.label);
  const slotsOf = (val) => labelsIn(val.message, labels, own(val.control));
  const mentions = [];
  for (const val of validators) {
    const slots = slotsOf(val);
    if (!slots.includes(slot)) continue;
    if (slots.length > 1) return { ok: false, reason: 'compound_message' };
    mentions.push(val);
  }
  const anchored = mentions.filter((x) => x.enabled !== false && validatorLabel(x.message, labels[slot], { anchored: true }));
  if (!anchored.length) return { ok: false, reason: 'no_validator' };
  const controls = [...new Set(mentions.map((x) => ctl(x.control)))];
  if (controls.length !== 1) return { ok: false, reason: 'multiple_controls' };
  const [id] = controls;
  if (!eligible.has(id)) return { ok: false, reason: 'ineligible_control' };
  const shared = validators.some((x) => ctl(x.control) === id && slotsOf(x).some((s) => s !== slot));
  if (shared) return { ok: false, reason: 'shared_control' };
  return { ok: true, id, evidence: { message: anchored[0].message } };
}
