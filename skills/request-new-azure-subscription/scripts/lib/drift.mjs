// Pure proofs for field drift. "Probabilities rank, proofs authorize": a remap is only
// authorized by page-owned evidence (ASP.NET Page_Validators), never by model confidence.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validatorLabel(message, label) {
  return new RegExp(`(?<![\\w-])${esc(label).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'i').test(String(message ?? ''));
}

// Labels that occur in the message, dropping any label that only appears inside a longer matched label.
function labelsIn(message, labels) {
  const hits = Object.entries(labels).filter(([, l]) => validatorLabel(message, l));
  return hits.filter(([, l]) => !hits.some(([, o]) => o !== l && o.length > l.length && validatorLabel(o, l)
    && !validatorLabel(String(message).replace(new RegExp(esc(o).replace(/\s+/g, '\\s+'), 'gi'), ' '), l)))
    .map(([slot]) => slot);
}

// validators: [{control, message}] from enabled Page_Validators. eligible: Set of control ids.
export function validatorProof(slot, validators, eligible, labels) {
  const own = [];
  for (const val of validators) {
    const slots = labelsIn(val.message, labels);
    if (!slots.includes(slot)) continue;
    if (slots.length > 1) return { ok: false, reason: 'compound_message' };
    own.push(val);
  }
  if (!own.length) return { ok: false, reason: 'no_validator' };
  const controls = [...new Set(own.map((x) => x.control))];
  if (controls.length !== 1) return { ok: false, reason: 'multiple_controls' };
  const [id] = controls;
  if (!eligible.has(id)) return { ok: false, reason: 'ineligible_control' };
  const shared = validators.some((x) => x.control === id && labelsIn(x.message, labels).some((s) => s !== slot));
  if (shared) return { ok: false, reason: 'shared_control' };
  return { ok: true, id, evidence: { message: own[0].message } };
}
