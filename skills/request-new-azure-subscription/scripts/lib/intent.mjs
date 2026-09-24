// Commit policy for resolving a user's free-text intent to one current option.
// Uncertainty selects the next machine action (refuse and report); it never selects a person,
// so identity and money slots (owner, manager, allowance) are never resolved by a model.

export const INTENT_SLOTS = new Set(['purpose', 'timezone', 'tenantType', 'tenantLicensing']);
export const COMMIT_P = 0.9;
export const COMMIT_MARGIN = 0.3;

const PLACEHOLDER = /^\s*(--\s*)?(select|choose|please select)\b.*$/i;

export function optionCriteria(options, redact) {
  const criteria = {};
  const keyToValue = {};
  let n = 0;
  for (const o of options) {
    if (o.value === '' || PLACEHOLDER.test(o.label ?? '')) continue;
    const key = `o${++n}`;
    criteria[key] = redact(o.label ?? '');
    keyToValue[key] = o.value;
  }
  criteria.none = 'None of these options matches the request.';
  return { criteria, keyToValue };
}

export function decideIntent(answer, keyToValue) {
  if (!answer?.ok) return { commit: false, reason: 'no_answer' };
  if (answer.choice === 'none') return { commit: false, reason: 'none' };
  if (!Object.hasOwn(keyToValue, answer.choice)) return { commit: false, reason: 'unknown_key' };
  if (!(answer.p >= COMMIT_P)) return { commit: false, reason: 'low_confidence', p: answer.p };
  if (!(answer.margin >= COMMIT_MARGIN)) return { commit: false, reason: 'narrow_margin', p: answer.p };
  return { commit: true, value: keyToValue[answer.choice], p: answer.p };
}
