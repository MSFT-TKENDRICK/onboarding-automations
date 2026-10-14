// Resolving the people, groups and Service Tree entries a request names. Matching is exact (id, e-mail, alias or full
// display name); anything ambiguous is handed back as candidates for the user to choose, never picked here.
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const aliasOf = (login) => String(login ?? '').replace(/_microsoft$/i, '');
const emailOf = (p) => (p.type === 'user' && /@/.test(p.secondaryText ?? '') ? String(p.secondaryText).trim() : null);

export const candidateView = (p) => ({ principalId: p.principalId, type: p.type, displayName: p.displayName, ...(emailOf(p) ? { email: emailOf(p) } : {}), ...(p.isRequester ? { isRequester: true } : {}) });

export function matchPrincipal(query, list) {
  const q = norm(query);
  if (!q) return { kind: 'none' };
  const tiers = [
    (p) => norm(p.principalId) === q,
    (p) => norm(emailOf(p)) === q,
    (p) => !q.includes('@') && !!emailOf(p) && norm(emailOf(p)).split('@')[0] === q,
    (p) => norm(p.displayName) === q,
  ];
  for (const t of tiers) {
    const hits = list.filter(t);
    if (hits.length === 1) return { kind: 'one', principal: hits[0] };
    if (hits.length > 1) return { kind: 'many', candidates: hits };
  }
  return { kind: 'none' };
}

export async function lookupPrincipals(s, { org, purpose, query, types = 'user,group' }) {
  const r = await s.api('principals', { query: { organization: org, purpose, query, types } });
  if (!r.ok) throw Object.assign(new Error(r.body?.detail ?? r.body?.title ?? `principal search failed (${r.status})`), { code: 'principal_search_failed', problem: r.body });
  return r.body;
}

// The search term to use when the stored identity is looked up again at submit time (the ref is short-lived).
export const lookupTerm = (p) => emailOf(p) ?? p.displayName;

export async function resolvePerson(s, { org, purpose, query, types }) {
  const list = await lookupPrincipals(s, { org, purpose, query, types });
  return { ...matchPrincipal(query, list), count: list.length };
}

export async function resolveRequester(s, { org, purpose }) {
  const alias = aliasOf(s.requester?.login);
  const list = await lookupPrincipals(s, { org, purpose, query: alias, types: 'user' });
  const me = list.find((p) => p.isRequester) ?? matchPrincipal(alias, list).principal;
  return me ?? null;
}

// Re-find a stored identity by id (submit). Returns the fresh principal, or null when it is gone or changed.
export async function refindPrincipal(s, { org, purpose, entry }) {
  const types = entry.type === 'group' ? 'group' : 'user';
  const list = await lookupPrincipals(s, { org, purpose, query: entry.lookup, types });
  return list.find((p) => p.principalId === entry.principalId && p.type === entry.type) ?? null;
}

// ---------------------------------------------------------------- Service Tree catalog
export function searchCatalog(catalog, text) {
  const q = norm(text);
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const view = (c) => ({ id: c.id, name: c.name, type: c.type, ...(c.parentId && byId.get(c.parentId) ? { parent: byId.get(c.parentId).name } : {}) });
  const exact = catalog.filter((c) => norm(c.name) === q);
  if (exact.length) return { exact: exact.map(view), near: [] };
  const rank = { Service: 0, ServiceGroup: 1, TeamGroup: 2, Organization: 3, Division: 4 };
  const near = catalog.filter((c) => norm(c.name).includes(q)).sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || a.name.length - b.name.length).slice(0, 15).map(view);
  return { exact: [], near };
}
