// Organisation defaults for a new repository: your manager becomes the second direct owner, and the people who report to
// your manager become the default team. People come from Microsoft Graph; their GitHub handle is the documented EMU
// handle <alias>_microsoft (GiM EMU FAQ), and each one is then matched exactly against StartRight's own principal search
// in the target organization, so nobody is added on the strength of a guessed handle.
import { GraphError } from './graph.mjs';
import { matchPrincipal, lookupPrincipals } from './resolve.mjs';

export const TEAM_LIMIT = 25;
export const TEAM_ROLES = ['read', 'triage', 'write'];
export const DEFAULT_TEAM_ROLE = 'write';

const lower = (s) => String(s ?? '').trim().toLowerCase();
export const aliasFromGraphUser = (u) => lower(u.mailNickname) || lower(String(u.userPrincipalName ?? '').split('@')[0]);
export const emailFromGraphUser = (u) => String(u.mail || u.userPrincipalName || '').trim();
export const githubHandleOf = (alias) => `${lower(alias)}_microsoft`;

export const personFromGraph = (u) => {
  const alias = aliasFromGraphUser(u);
  return { id: u.id, displayName: u.displayName ?? alias, email: emailFromGraphUser(u), alias, githubHandle: githubHandleOf(alias), ...(u.jobTitle ? { jobTitle: u.jobTitle } : {}) };
};

// { ok: true, manager, peers } or { ok: false, code, message }. Never throws for Graph problems: the defaults are a
// convenience, so a failure degrades to asking the user.
export async function loadOrgContext(graph, requesterAlias) {
  try {
    const me = await graph.me();
    if (!me) return { ok: false, code: 'graph_failed', message: 'Microsoft Graph did not return the signed-in user.' };
    if (aliasFromGraphUser(me) !== lower(requesterAlias)) {
      return { ok: false, code: 'graph_identity_mismatch', message: `The Azure CLI is signed in as ${aliasFromGraphUser(me)}, but StartRight is signed in as ${lower(requesterAlias)}_microsoft. Sign the Azure CLI in as the same person ("az login") so the right manager and team are used.` };
    }
    const manager = await graph.manager();
    if (!manager) return { ok: false, code: 'no_manager', message: 'Microsoft Graph shows no manager for you.' };
    const reports = await graph.directReports(manager.id);
    const peers = reports
      .filter((u) => u.id !== me.id && u.id !== manager.id && u.accountEnabled !== false)
      .map(personFromGraph)
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.alias.localeCompare(b.alias));
    return { ok: true, manager: personFromGraph(manager), peers };
  } catch (e) {
    if (e instanceof GraphError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

// Match one Graph person to exactly one StartRight principal by exact e-mail (never by display name: that could be a
// namesake). Returns null when there is no single exact match.
export async function findStartRightUser(s, { org, purpose, person }) {
  let list;
  try { list = await lookupPrincipals(s, { org, purpose, query: person.email, types: 'user' }); }
  catch (e) { if (e.code === 'principal_search_failed') return null; throw e; }
  const m = matchPrincipal(person.email, list.filter((p) => p.type === 'user'));
  return m.kind === 'one' && lower(m.principal.secondaryText) === lower(person.email) ? m.principal : null;
}
