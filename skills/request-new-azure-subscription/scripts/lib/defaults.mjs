// Defaults for inputs the user did not give. Each one is applied only when it maps to exactly one live option;
// the plan reports every defaulted value so the user can override it before accepting.
export const DEFAULT_TYPE = 'internal';

const real = (options = []) => options.filter((o) => o.value !== '' && o.value != null);
const amount = (o) => {
  const m = String(o.label ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/) ?? String(o.value ?? '').replace(/,/g, '').match(/^\d+(?:\.\d+)?$/);
  return m ? Number(m[0]) : NaN;
};

// The largest monthly allowance offered. null when any amount is unreadable or the maximum is not unique.
export function highestAmount(options) {
  const pool = real(options).map((o) => ({ o, n: amount(o) }));
  if (!pool.length || pool.some((x) => Number.isNaN(x.n))) return null;
  const max = Math.max(...pool.map((x) => x.n));
  const top = pool.filter((x) => x.n === max);
  return top.length === 1 ? top[0].o : null;
}

export function onlyOption(options) {
  const pool = real(options);
  return pool.length === 1 ? pool[0] : null;
}

export function defaultTitle(ownerUpn, date = new Date()) {
  const alias = String(ownerUpn ?? '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!alias) return null;
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${alias} Azure subscription ${d}`;
}

export function systemTimeZone(env = process.env) {
  return env.MCAPS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}
