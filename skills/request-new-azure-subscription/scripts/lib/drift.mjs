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

// Labels that occur in the message, dropping any label that only appears inside a longer matched label.
function labelsIn(message, labels) {
  const hits = Object.entries(labels).filter(([, l]) => validatorLabel(message, l));
  return hits.filter(([, l]) => !hits.some(([, o]) => o !== l && o.length > l.length && validatorLabel(o, l)
    && !validatorLabel(String(message).replace(new RegExp(esc(o).replace(/\s+/g, '\\s+'), 'gi'), ' '), l)))
    .map(([slot]) => slot);
}

// validators: [{control, message, enabled?}] from Page_Validators. eligible: Set of control ids.
// Evidence: enabled validators whose message starts with the slot's label. Every validator that mentions the label,
// enabled or not, must agree on the control; any compound or shared message voids the proof.
export function validatorProof(slot, validators, eligible, labels) {
  const mentions = [];
  for (const val of validators) {
    const slots = labelsIn(val.message, labels);
    if (!slots.includes(slot)) continue;
    if (slots.length > 1) return { ok: false, reason: 'compound_message' };
    mentions.push(val);
  }
  const own = mentions.filter((x) => x.enabled !== false && validatorLabel(x.message, labels[slot], { anchored: true }));
  if (!own.length) return { ok: false, reason: 'no_validator' };
  const controls = [...new Set(mentions.map((x) => x.control))];
  if (controls.length !== 1) return { ok: false, reason: 'multiple_controls' };
  const [id] = controls;
  if (!eligible.has(id)) return { ok: false, reason: 'ineligible_control' };
  const shared = validators.some((x) => x.control === id && labelsIn(x.message, labels).some((s) => s !== slot));
  if (shared) return { ok: false, reason: 'shared_control' };
  return { ok: true, id, evidence: { message: own[0].message } };
}
