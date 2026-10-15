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
    // Everyone a "your manager's directs" group may legitimately contain: all direct reports (even disabled ones), the manager and you.
    const memberIds = new Set([me.id, manager.id, ...reports.map((u) => u.id)]);
    return { ok: true, manager: personFromGraph(manager), peers, memberIds };
  } catch (e) {
    if (e instanceof GraphError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

// Who is in a group, measured against your manager's team. outsiders: people who do not report to your manager (nor are
// the manager or you). nested: members that are not people (nested groups are not de-nested by Entra SCIM). missing: the
// default-team people the group does not contain.
async function inspectGroup(graph, ctx, group) {
  const { users, others } = await graph.groupMembers(group.id);
  const have = new Set(users.map((u) => u.id));
  return {
    members: users.length,
    outsiders: users.filter((u) => !ctx.memberIds.has(u.id)).map(personFromGraph),
    nested: others,
    missing: ctx.peers.filter((p) => !have.has(p.id)),
  };
}

// An Entra group may stand in for the default team only if it provably holds nobody but your manager's team. The group is
// bound to the StartRight principal by mail nickname and exact display name (a look-alike such as "FrankDirects" versus
// "Frank's Directs" is never accepted on its name alone); then its members are read from Graph.
export async function verifyTeamGroup(graph, ctx, { displayName, keys }) {
  try {
    const found = new Map();
    for (const key of new Set(keys.map((k) => String(k ?? '').trim()).filter(Boolean))) {
      for (const g of await graph.groupsByNickname(key)) if (g.mailEnabled && String(g.displayName ?? '').trim() === String(displayName ?? '').trim()) found.set(g.id, g);
    }
    if (found.size !== 1) return { ok: false, code: 'team_group_unverifiable', message: `Microsoft Graph does not show exactly one mail-enabled group named "${displayName}" with that alias (it found ${found.size}), so its members cannot be checked.` };
    const group = [...found.values()][0];
    const r = await inspectGroup(graph, ctx, group);
    if (r.outsiders.length || r.nested) {
      return { ok: false, code: 'team_group_not_directs', message: `"${group.displayName}" is not a group of the people who report to ${ctx.manager.displayName}: it also contains ${r.outsiders.length ? r.outsiders.map((p) => p.displayName).join(', ') : ''}${r.outsiders.length && r.nested ? ' and ' : ''}${r.nested ? `${r.nested} nested group(s) or non-person member(s)` : ''}. Name the people with --access instead, or choose another group.`, outsiders: r.outsiders.map((p) => ({ displayName: p.displayName, email: p.email })) };
    }
    return { ok: true, group, missing: r.missing, members: r.members };
  } catch (e) {
    if (e instanceof GraphError) return { ok: false, code: e.code === 'graph_too_large' ? 'team_group_unverifiable' : e.code, message: e.message };
    throw e;
  }
}

// Groups you belong to that look like a directs group, each checked against your manager's team. Only a preview: nothing is
// ever chosen from it.
export async function suggestTeamGroups(graph, ctx) {
  try {
    const mine = (await graph.myGroups()).filter((g) => g.mailEnabled && /direct|report/i.test(`${g.displayName} ${g.mailNickname}`)).slice(0, 10);
    const out = [];
    for (const g of mine) {
      const r = await inspectGroup(graph, ctx, g);
      out.push({ displayName: g.displayName, alias: g.mailNickname, email: g.mail, members: r.members, status: r.outsiders.length || r.nested ? 'has_outsiders' : r.missing.length ? 'partial' : 'matches', ...(r.outsiders.length ? { outsiders: r.outsiders.length } : {}) });
    }
    return out;
  } catch (e) {
    if (e instanceof GraphError) return [];
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
