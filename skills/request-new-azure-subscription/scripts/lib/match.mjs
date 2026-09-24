// Deterministic matching of user-supplied values to live portal options. Never picks a default.

export const normalize = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const tokens = (s) => normalize(s).split(/[^a-z0-9]+/).filter(Boolean);
const digits = (s) => String(s ?? '').replace(/[^0-9.]/g, '').replace(/\.0+$/, '');

// IANA zone -> fragment of the Windows display name the portal uses.
const IANA = {
  'america/los_angeles': 'pacific time (us & canada)', 'america/vancouver': 'pacific time (us & canada)',
  'america/denver': 'mountain time (us & canada)', 'america/phoenix': 'arizona',
  'america/chicago': 'central time (us & canada)', 'america/new_york': 'eastern time (us & canada)',
  'america/toronto': 'eastern time (us & canada)', 'america/anchorage': 'alaska', 'pacific/honolulu': 'hawaii',
  'america/sao_paulo': 'brasilia', 'america/mexico_city': 'guadalajara, mexico city, monterrey',
  'europe/london': 'dublin, edinburgh, lisbon, london', 'europe/dublin': 'dublin, edinburgh, lisbon, london',
  'europe/berlin': 'amsterdam, berlin, bern, rome, stockholm, vienna', 'europe/amsterdam': 'amsterdam, berlin, bern, rome, stockholm, vienna',
  'europe/paris': 'brussels, copenhagen, madrid, paris', 'europe/madrid': 'brussels, copenhagen, madrid, paris',
  'europe/warsaw': 'sarajevo, skopje, warsaw, zagreb', 'europe/prague': 'belgrade, bratislava, budapest, ljubljana, prague',
  'asia/jerusalem': 'jerusalem', 'asia/dubai': 'abu dhabi, muscat', 'asia/kolkata': 'chennai, kolkata, mumbai, new delhi',
  'asia/calcutta': 'chennai, kolkata, mumbai, new delhi', 'asia/shanghai': 'beijing, chongqing, hong kong, urumqi',
  'asia/singapore': 'kuala lumpur, singapore', 'asia/tokyo': 'osaka, sapporo, tokyo', 'asia/seoul': 'seoul',
  'australia/sydney': 'canberra, melbourne, sydney', 'pacific/auckland': 'auckland, wellington',
  'etc/utc': 'coordinated universal time', utc: 'coordinated universal time',
};
const OFFSET = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/;

const real = (options) => options.filter((o) => o.value !== '' && o.value != null);
const ok = (o, matchedBy) => ({ ok: true, value: o.value, label: o.label, matchedBy });
const fail = (error, pool, wanted, max = 12) => ({ ok: false, error, wanted: String(wanted ?? ''), candidates: pool.slice(0, max).map((o) => o.label) });
const decide = (hits, matchedBy, wanted) => (hits.length === 1 ? ok(hits[0], matchedBy) : hits.length > 1 ? fail('ambiguous', hits, wanted, 25) : null);

export function matchOption(options, wanted, { kind } = {}) {
  const pool = real(options);
  if (!pool.length) return { ok: false, error: 'no_options', wanted: String(wanted ?? ''), candidates: [] };
  const w = normalize(wanted);
  if (!w) return fail('no_match', pool, wanted);
  const byValue = pool.find((o) => String(o.value) === String(wanted).trim());
  if (byValue) return ok(byValue, 'value');
  if (kind === 'money') {
    const d = digits(wanted);
    return decide(pool.filter((o) => digits(o.value) === d || digits(o.label) === d), 'label', wanted) ?? fail('no_match', pool, wanted);
  }
  const byLabel = decide(pool.filter((o) => normalize(o.label) === w), 'label', wanted);
  if (byLabel) return byLabel;
  if (kind === 'timezone') {
    const frag = IANA[w];
    if (frag) return decide(pool.filter((o) => normalize(o.label).includes(frag)), 'alias', wanted) ?? fail('no_match', pool, wanted);
    const m = w.match(OFFSET);
    if (m) {
      const prefix = `(utc${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'})`;
      return decide(pool.filter((o) => normalize(o.label).startsWith(prefix)), 'partial', wanted) ?? fail('no_match', pool, wanted);
    }
  }
  const wt = tokens(wanted);
  const hits = pool.filter((o) => {
    const l = normalize(o.label);
    if (l.includes(w)) return true;
    const lt = new Set(tokens(o.label));
    return wt.length > 0 && wt.every((t) => lt.has(t));
  });
  return decide(hits, 'partial', wanted) ?? fail('no_match', rank(pool, wt), wanted);
}

function rank(pool, wt) {
  if (pool.length <= 12) return pool;
  const score = (o) => { const lt = tokens(o.label); return wt.filter((t) => lt.some((x) => x.startsWith(t) || t.startsWith(x))).length; };
  return [...pool].sort((a, b) => score(b) - score(a)).slice(0, 8);
}

export function parseSuggestion(text) {
  const [display, upn = ''] = String(text).split(';').map((s) => s.trim());
  return { display, upn: upn.toLowerCase() };
}

// People are matched exactly (UPN, alias or full display name). No partial matches: a wrong owner is costly.
export function matchOwner(suggestions, wanted) {
  const items = suggestions.map((s, index) => ({ index, ...(typeof s === 'string' ? parseSuggestion(s) : s) }));
  const w = normalize(wanted);
  const labelOf = (i) => (i.upn ? `${i.display} <${i.upn}>` : i.display);
  let hits;
  let matchedBy;
  if (w.includes('@')) { hits = items.filter((i) => i.upn === w); matchedBy = 'upn'; }
  else if (!w.includes(' ')) { hits = items.filter((i) => i.upn.split('@')[0] === w); matchedBy = 'alias'; }
  else { hits = items.filter((i) => normalize(i.display) === w); matchedBy = 'display'; }
  if (hits.length === 1) { const h = hits[0]; return { ok: true, index: h.index, display: h.display, upn: h.upn, matchedBy }; }
  return { ok: false, error: hits.length ? 'ambiguous' : 'no_match', wanted: String(wanted ?? ''), candidates: (hits.length ? hits : items).slice(0, 10).map(labelOf) };
}

export function ownerSearchTerm(wanted) {
  const w = String(wanted ?? '').trim();
  const term = w.includes('@') ? w.split('@')[0].toLowerCase() : w;
  if (term.length < 3) throw new Error('Owner search needs at least 3 characters (alias, email, or full name).');
  return term;
}
