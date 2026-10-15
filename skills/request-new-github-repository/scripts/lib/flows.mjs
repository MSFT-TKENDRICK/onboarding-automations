// plan / options / submit / status flows. Everything the service says is contract-checked by client.api(); everything
// the user said is validated here before any request is built.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillError } from './client.mjs';
import { CreateBody, validate, classifyCreate, checkResponse, isGuid } from './contract.mjs';
import { TERMS, WARN, PROXIMA_GUIDANCE, LINKS, classify, validateRepo, parseRole, accessErrors } from './policy.mjs';
import { aliasOf, candidateView, lookupPrincipals, lookupTerm, resolvePerson, resolveRequester, refindPrincipal, searchCatalog } from './resolve.mjs';
import { TEAM_LIMIT, TEAM_ROLES, DEFAULT_TEAM_ROLE, loadOrgContext, findStartRightUser } from './team.mjs';
import { acquireSubmitLock, markSent, recordOutcome, releaseUnsent, readLock, requestKey } from './plan-store.mjs';

export const PLAN_SCHEMA = 1;
const norm = (s) => String(s ?? '').trim().toLowerCase();
const sameOrg = (a, b) => norm(a) === norm(b);
const t = (v) => (v === undefined || v === null ? undefined : String(v).trim());

export function normalizeInput(raw = {}) {
  const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
  return {
    org: t(raw.org), name: t(raw.name), description: t(raw.description), visibility: t(raw.visibility)?.toLowerCase(), classification: t(raw.classification),
    serviceTree: t(raw.serviceTree), serviceTreeName: t(raw.serviceTreeName), owners: list(raw.owners), access: list(raw.access),
    noDefaultTeam: raw.noDefaultTeam === true, noManagerOwner: raw.noManagerOwner === true, teamRole: t(raw.teamRole)?.toLowerCase(),
  };
}

export function parseAccess(spec) {
  const i = String(spec).lastIndexOf('=');
  if (i < 1) return { error: { code: 'access_role_required', field: 'access', query: spec, message: `"${spec}": use <person-or-group>=<role>, with a role of read, triage, write or maintain.` } };
  const who = spec.slice(0, i).trim();
  const role = parseRole(spec.slice(i + 1));
  if (!who || !role) return { error: { code: 'access_role_invalid', field: 'access', query: spec, message: `"${spec}": the role must be read, triage, write or maintain.` } };
  return { who, role };
}

// ---------------------------------------------------------------- local checks (no network, no browser)
export function localCheck(input) {
  const out = { missing: [], errors: [], blockers: [], defaulted: [], access: [] };
  const cls = classify(input.classification);
  if (cls.kind === 'missing') out.missing.push({ field: 'classification', message: 'Ask the user: will this repository host production services, or contain TCB or HVT code? Only non-production repositories can be created in GitHub EMU.', options: ['non-production'] });
  else if (cls.kind === 'blocked') out.blockers.push({ code: 'production_not_allowed', message: PROXIMA_GUIDANCE, links: [LINKS.proxima, LINKS.support] });
  else if (cls.kind === 'invalid') out.errors.push({ code: 'classification_invalid', field: 'classification', message: 'Use --classification non-production. Production, TCB and HVT repositories cannot be created here.' });

  const visibility = input.visibility ?? 'internal';
  if (!input.visibility) out.defaulted.push({ field: 'visibility', value: 'internal', why: 'the StartRight default' });
  for (const e of validateRepo({ org: input.org, name: input.name, description: input.description, visibility })) {
    if (e.code.endsWith('_required')) out.missing.push({ field: e.field, message: e.message });
    else out.errors.push(e);
  }

  const modes = [input.serviceTree, input.serviceTreeName, input.owners.length ? 'owners' : undefined].filter(Boolean);
  if (modes.length > 1) out.errors.push({ code: 'ownership_conflict', field: 'ownership', message: 'Give either a Service Tree entry (--service-tree / --service-tree-name) or direct owners (--direct-owner), not both.' });
  if (input.serviceTree && !isGuid(input.serviceTree)) out.errors.push({ code: 'service_tree_invalid', field: 'serviceTree', message: '--service-tree must be a Service Tree GUID. Use --service-tree-name to look one up by name.' });
  if (input.owners.length > 2) out.errors.push({ code: 'too_many_owners', field: 'ownership', message: 'Direct ownership takes exactly two owners (you plus one other).' });
  if (!modes.length) out.missing.push({ field: 'ownership', code: 'ownership_required', message: 'Ask the user who owns the repository: a Service Tree entry (--service-tree <guid> or --service-tree-name <name>) or one other direct owner (--direct-owner <person>; you are added as the second).' });
  if (input.teamRole && !TEAM_ROLES.includes(input.teamRole)) out.errors.push({ code: 'team_role_invalid', field: 'teamRole', message: `--team-role must be ${TEAM_ROLES.join(', ')} (maintain is only given to you and your manager).` });

  for (const spec of input.access) {
    const p = parseAccess(spec);
    if (p.error) out.errors.push(p.error); else out.access.push(p);
  }
  return { ...out, visibility };
}

export async function begin(s) {
  s.assertGuarded();
  const me = await s.ensureAuth();
  if (!/_microsoft$/i.test(me.login)) throw new SkillError('non_microsoft_account', `StartRight signed in as "${me.login}", which is not a Microsoft EMU account (expected <alias>_microsoft).`);
  return me;
}

async function memberOrg(s, org) {
  const r = await s.api('organizations');
  if (!r.ok) throw new SkillError('forbidden', `StartRight refused the organization list (${r.status}${r.body?.detail ? `: ${r.body.detail}` : ''}).`);
  return { orgs: r.body, match: org ? r.body.find((o) => sameOrg(o.login, org)) : null };
}

const personView = (p) => ({ displayName: p.displayName, type: p.type, ...(p.email ? { email: p.email } : {}), ...(p.githubHandle ? { githubHandle: p.githubHandle } : {}) });

// ---------------------------------------------------------------- plan
export async function runPlan(s, input, local, { graph } = {}) {
  s.guard.setPhase('plan');
  const R = { missing: [...local.missing], errors: [...local.errors], blockers: [...local.blockers], defaulted: [...local.defaulted], warnings: [] };
  await begin(s);
  const requester = s.requester;
  const { orgs, match } = await memberOrg(s, input.org);
  const orgMissing = R.missing.find((m) => m.field === 'org');
  if (orgMissing) orgMissing.options = orgs.map((o) => o.login);
  let org = null;
  if (input.org && !R.errors.some((e) => e.field === 'org')) {
    if (match) org = match.login;
    else {
      const j = await s.api('joinable', { query: { query: input.org, top: 10 } });
      if (j.ok && j.body.some((o) => sameOrg(o.login, input.org))) R.blockers.push({ code: 'not_a_member', organization: input.org, message: `You are not a member of ${input.org}. Join it in StartRight first (Set up repository > Owner organization > Join organization); this skill does not join organizations.`, links: [LINKS.startright] });
      else R.errors.push({ code: 'org_unknown', field: 'org', message: `"${input.org}" is not an organization you belong to or can join. Your organizations: ${orgs.map((o) => o.login).join(', ') || '(none)'}.`, candidates: orgs.map((o) => o.login) });
    }
  }
  if (R.blockers.length) return finish(R, null, requester);

  if (org && input.name && !R.errors.some((e) => e.field === 'name')) {
    const a = await s.api('availability', { query: { organization: org, name: input.name } });
    if (!a.ok) R.errors.push({ code: 'name_invalid', field: 'name', message: `StartRight rejected the name: ${a.body?.detail ?? a.body?.title ?? a.status}.` });
    else if (!a.body.available) R.errors.push({ code: 'name_unavailable', field: 'name', message: `${org}/${input.name} already exists or is reserved. Choose another name.` });
  }
  if (!org) return finish(R, null, requester);

  const people = { ownership: [], access: [] };
  let personProblems = false;
  const find = async (field, who, purpose, types) => {
    const r = await resolvePerson(s, { org, purpose, query: who, types });
    if (r.kind === 'one') return { ...r.principal, email: candidateView(r.principal).email, lookup: lookupTerm(r.principal) };
    personProblems = true;
    if (r.kind === 'many') R.missing.push({ field, code: 'ambiguous_person', query: who, message: `"${who}" matches more than one ${types === 'user' ? 'person' : 'person or group'}; ask the user which one and pass that e-mail (or group name) exactly.`, candidates: r.candidates.map(candidateView) });
    else R.errors.push({ code: 'person_not_found', field, query: who, message: `No ${types === 'user' ? 'person' : 'person or group'} matches "${who}" exactly (use an e-mail, alias or full display name). Use options --find-principal to search.` });
    return null;
  };
  const me = async (purpose) => {
    const p = await resolveRequester(s, { org, purpose });
    if (!p) { personProblems = true; R.errors.push({ code: 'requester_not_found', field: 'requester', message: `StartRight did not return you (${requester.login}) as a ${purpose === 'acl' ? 'permission' : 'ownership'} principal in ${org}.` }); return null; }
    return { ...p, email: candidateView(p).email, lookup: lookupTerm(p) };
  };

  // ---- manager and team defaults (Microsoft Graph); degrade to asking the user when Graph cannot answer
  const explicitOwnership = !!(input.serviceTree || input.serviceTreeName || input.owners.length);
  const wantManager = !input.noManagerOwner;
  const wantTeam = !input.noDefaultTeam;
  let orgCtx = null;
  if (graph && (wantManager || wantTeam)) {
    orgCtx = await loadOrgContext(graph, aliasOf(requester.login));
    if (!orgCtx.ok) { R.warnings.push({ code: 'org_defaults_skipped', reason: orgCtx.code, message: `Your manager and default team could not be looked up, so they were not added: ${orgCtx.message}` }); orgCtx = null; }
  }
  let managerIsOwner = false;

  // ---- ownership
  let ownership = null;
  if (input.serviceTree && isGuid(input.serviceTree) && !R.errors.some((e) => e.code === 'ownership_conflict')) {
    const id = input.serviceTree.trim().toLowerCase();
    const r = await s.api('restriction', { query: { organization: org, serviceTreeId: id } });
    if (!r.ok) R.errors.push({ code: 'service_tree_invalid', field: 'serviceTree', message: `StartRight rejected the Service Tree id: ${r.body?.detail ?? r.body?.title ?? r.status}.` });
    else if (r.body.blocked) R.blockers.push({ code: 'service_restricted', message: r.body.message ?? 'New repositories are blocked for this Service Tree entry.', ...(r.body.policyUrl ? { links: [r.body.policyUrl] } : {}) });
    else ownership = { type: 'serviceTree', serviceTreeId: id };
  } else if (input.serviceTreeName && !R.errors.some((e) => e.code === 'ownership_conflict')) {
    const cat = await s.api('catalog');
    const { exact, near } = searchCatalog(cat.body, input.serviceTreeName);
    if (exact.length === 1) {
      const hit = exact[0];
      const r = await s.api('restriction', { query: { organization: org, serviceTreeId: hit.id } });
      if (!r.ok) R.errors.push({ code: 'service_tree_invalid', field: 'serviceTreeName', message: `StartRight rejected "${hit.name}": ${r.body?.detail ?? r.body?.title ?? r.status}.` });
      else if (r.body.blocked) R.blockers.push({ code: 'service_restricted', message: r.body.message ?? `New repositories are blocked for ${hit.name}.`, ...(r.body.policyUrl ? { links: [r.body.policyUrl] } : {}) });
      else {
        ownership = { type: 'serviceTree', serviceTreeId: hit.id, serviceName: hit.name, serviceType: hit.type };
        if (hit.type === 'Division' || hit.type === 'Organization') R.warnings.push({ code: 'coarse_service_tree', message: `"${hit.name}" is a ${hit.type}, which is a very coarse owner. Confirm with the user that this is intended.` });
      }
    } else if (exact.length > 1) R.missing.push({ field: 'serviceTree', code: 'ambiguous_service', message: `More than one Service Tree entry is named "${input.serviceTreeName}"; ask the user which one and pass its id with --service-tree.`, candidates: exact });
    else R.errors.push({ code: 'service_not_found', field: 'serviceTreeName', message: `No Service Tree entry is named "${input.serviceTreeName}" exactly.`, ...(near.length ? { candidates: near } : {}) });
  } else if (input.owners.length && input.owners.length <= 2 && !R.errors.some((e) => e.code === 'ownership_conflict')) {
    const owners = [];
    for (const who of input.owners) { const p = await find('ownership', who, 'ownership', 'user'); if (p) owners.push(p); }
    const rq = await me('ownership');
    if (new Set(owners.map((o) => o.principalId)).size !== owners.length) { R.errors.push({ code: 'owner_duplicate', field: 'ownership', message: 'The same person is listed as an owner twice.' }); personProblems = true; }
    else if (!personProblems && rq) {
      if (owners.length < 2 && !owners.some((o) => o.principalId === rq.principalId)) { owners.unshift(rq); R.defaulted.push({ field: 'ownership', value: `${rq.displayName} (you)`, why: 'the requester is always one of the two direct owners' }); }
      if (owners.length === 2) { ownership = { type: 'directOwners', owners }; people.ownership = owners; }
      else R.missing.push({ field: 'ownership', code: 'second_owner', message: 'Direct ownership needs two different owners: ask the user for the other owner (--direct-owner <person>).' });
    }
  } else if (!explicitOwnership && orgCtx && wantManager) {
    const mgr = await findStartRightUser(s, { org, purpose: 'ownership', person: orgCtx.manager });
    const rq = mgr ? await me('ownership') : null;
    if (mgr && rq) {
      const m = { ...mgr, email: orgCtx.manager.email, lookup: lookupTerm(mgr), githubHandle: orgCtx.manager.githubHandle };
      ownership = { type: 'directOwners', owners: [rq, m] }; people.ownership = [rq, m]; managerIsOwner = true;
      R.missing = R.missing.filter((x) => x.code !== 'ownership_required');
      R.defaulted.push({ field: 'ownership', value: `${rq.displayName} (you) and ${m.displayName} (${m.githubHandle}), your manager`, why: 'your manager is a co-owner by default; pass --direct-owner or a Service Tree entry to choose differently, or --no-manager-owner to opt out' });
    } else if (!mgr) R.warnings.push({ code: 'manager_not_found', message: `Your manager (${orgCtx.manager.displayName}, ${orgCtx.manager.githubHandle}) is not a person StartRight can find in ${org}, so they were not made co-owner. Ask the user for the second owner.` });
  }

  // ---- access
  const acl = [];
  for (const { who, role } of local.access) { const p = await find('access', who, 'acl', 'user,group'); if (p) acl.push({ ...p, role }); }
  const rq = await me('acl');
  if (!personProblems && rq) {
    const mine = acl.find((a) => a.principalId === rq.principalId);
    if (mine && mine.role !== 'maintain') R.errors.push({ code: 'requester_must_maintain', field: 'access', message: 'You (the requester) must have the maintain role on the repository you create.' });
    else if (!mine) { acl.unshift({ ...rq, role: 'maintain' }); R.defaulted.push({ field: 'access', value: `${rq.displayName} (you): maintain`, why: 'the requester is always added with the maintain role' }); }

    // Your manager is a co-owner, so they also maintain the repository. A Service Tree owner cannot be a direct co-owner, so
    // maintain is the closest StartRight can express. Someone else named as owner means the manager is not added.
    if (orgCtx && wantManager && (managerIsOwner || ownership?.type === 'serviceTree')) {
      const mgr = await findStartRightUser(s, { org, purpose: 'acl', person: orgCtx.manager });
      const m = mgr && { ...mgr, email: orgCtx.manager.email, lookup: lookupTerm(mgr), githubHandle: orgCtx.manager.githubHandle };
      if (!m) R.warnings.push({ code: 'manager_not_found', message: `Your manager (${orgCtx.manager.displayName}, ${orgCtx.manager.githubHandle}) is not a person StartRight can find in ${org}, so they were not given access.` });
      else if (!acl.some((a) => a.principalId === m.principalId)) {
        acl.push({ ...m, role: 'maintain' });
        R.defaulted.push({ field: 'access', value: `${m.displayName} (${m.githubHandle}), your manager: maintain`, why: managerIsOwner ? 'your manager is a co-owner by default' : 'a Service Tree entry owns the repository, so your manager cannot be a direct co-owner; maintain is the closest access StartRight offers' });
      }
    }

    // Default team: everyone else who reports to your manager, matched to StartRight by exact e-mail.
    if (orgCtx && wantTeam) {
      if (orgCtx.peers.length > TEAM_LIMIT) R.missing.push({ field: 'access', code: 'default_team_too_large', count: orgCtx.peers.length, message: `${orgCtx.manager.displayName} has ${orgCtx.peers.length} direct reports, more than the ${TEAM_LIMIT} a default team may hold. Ask the user to list the people (--access <person>=write) or to skip the default team (--no-default-team).` });
      else {
        const role = input.teamRole ?? DEFAULT_TEAM_ROLE;
        const added = [];
        const unresolved = [];
        for (const peer of orgCtx.peers) {
          const found = await findStartRightUser(s, { org, purpose: 'acl', person: peer });
          if (!found) { unresolved.push(peer); continue; }
          if (acl.some((a) => a.principalId === found.principalId)) continue;
          const entry = { ...found, email: peer.email, lookup: lookupTerm(found), githubHandle: peer.githubHandle, role };
          acl.push(entry); added.push(entry);
        }
        if (added.length) R.defaulted.push({ field: 'access', value: `${added.map((a) => `${a.displayName} (${a.githubHandle})`).join(', ')}: ${role}`, why: `the default team: the people who report to your manager, ${orgCtx.manager.displayName}; pass --no-default-team to skip it` });
        if (unresolved.length) R.warnings.push({ code: 'team_members_unresolved', message: `Not added, because StartRight finds no single matching person in ${org}: ${unresolved.map((p) => `${p.displayName} (${p.githubHandle})`).join(', ')}. They may not have an EMU account in this organization yet.` });
      }
    }
    for (const e of accessErrors(acl.map((a) => ({ principalId: a.principalId, type: a.type, role: a.role, displayName: a.displayName })), rq.principalId)) {
      if (e.code === 'maintain_rule') R.missing.push({ field: 'access', code: 'maintain_rule', message: `${e.message} Ask the user for a second maintainer (a person) or a group to add (--access <person-or-group>=maintain).` });
      else if (e.code !== 'requester_must_maintain') R.errors.push({ code: e.code, field: 'access', message: e.message });
    }
    people.access = acl;
  }

  R.warnings.push(WARN.prefer_proxima, WARN.secret_scan, WARN.propagation);
  if (acl.some((a) => a.type === 'group')) R.warnings.push(WARN.group_delay);

  const ready = !R.errors.length && !R.blockers.length && !R.missing.length && ownership && people.access.length;
  const material = ready ? {
    v: PLAN_SCHEMA, baseUrl: s.baseUrl, requester: { login: requester.login, userId: requester.userId }, org,
    repo: { name: input.name, visibility: local.visibility, description: input.description }, classification: 'nonproduction',
    ownership: ownership.type === 'directOwners' ? { type: 'directOwners', owners: slim(people.ownership) } : ownership,
    access: slim(acl).sort((a, b) => a.principalId.localeCompare(b.principalId)), terms: TERMS.sha,
  } : null;
  return finish(R, material, requester);
}

const slim = (list) => list.map((p) => ({ principalId: p.principalId, type: p.type, displayName: p.displayName, lookup: p.lookup, ...(p.email ? { email: p.email } : {}), ...(p.githubHandle ? { githubHandle: p.githubHandle } : {}), ...(p.role ? { role: p.role } : {}) }));

function finish(R, material, requester, extra = {}) {
  const status = R.errors.length ? 'invalid' : R.blockers.length ? 'blocked' : R.missing.length ? 'needs_input' : material ? 'ready' : 'invalid';
  const m = material;
  const resolved = m && {
    requester: m.requester.login, organization: m.org, repository: m.repo, classification: 'non-production',
    ownership: m.ownership.type === 'serviceTree' ? { type: 'serviceTree', serviceTreeId: m.ownership.serviceTreeId, ...(m.ownership.serviceName ? { name: m.ownership.serviceName } : {}) } : { type: 'directOwners', owners: m.ownership.owners.map(personView) },
    access: m.access.map((a) => ({ ...personView(a), role: a.role })),
  };
  return { status, material, resolved, missing: R.missing, errors: R.errors, blockers: R.blockers, defaulted: R.defaulted, warnings: R.warnings, requester: requester?.login, ...extra };
}

export const termsView = () => ({ sha: TERMS.sha, text: TERMS.text, links: TERMS.links });

// ---------------------------------------------------------------- body
export function buildBody(m, refs) {
  return {
    organization: m.org,
    repository: { name: m.repo.name, visibility: m.repo.visibility, description: m.repo.description },
    ownership: m.ownership.type === 'serviceTree' ? { type: 'serviceTree', serviceTreeId: m.ownership.serviceTreeId } : { type: 'directOwners', owners: m.ownership.owners.map((o) => refs.ownership[o.principalId]) },
    accessControl: m.access.map((a) => ({ principalRef: refs.acl[a.principalId], principalType: a.type, permission: a.role })),
    classification: 'nonproduction',
  };
}

// Independent of buildBody: the body about to be sent must say exactly what the plan the user accepted says.
export function bodyDiffersFromPlan(body, m, refs) {
  const bad = [];
  if (body.organization !== m.org) bad.push('organization');
  if (body.repository.name !== m.repo.name || body.repository.visibility !== m.repo.visibility || body.repository.description !== m.repo.description) bad.push('repository');
  if (body.classification !== 'nonproduction') bad.push('classification');
  if (m.ownership.type === 'serviceTree') { if (body.ownership.type !== 'serviceTree' || body.ownership.serviceTreeId !== m.ownership.serviceTreeId) bad.push('ownership'); }
  else if (body.ownership.type !== 'directOwners' || body.ownership.owners.length !== m.ownership.owners.length || m.ownership.owners.some((o, i) => body.ownership.owners[i] !== refs.ownership[o.principalId])) bad.push('ownership');
  if (body.accessControl.length !== m.access.length || m.access.some((a, i) => { const x = body.accessControl[i]; return x.principalRef !== refs.acl[a.principalId] || x.principalType !== a.type || x.permission !== a.role; })) bad.push('accessControl');
  return bad;
}

// ---------------------------------------------------------------- submit
const notSubmitted = (reason, message, extra = {}) => ({ outcome: 'not_submitted', reason, message, ...extra });

export async function runSubmit(s, plan, { dir }) {
  s.guard.setPhase('submit');
  const m = plan.material;
  await begin(s);
  if (!sameOrg(s.requester.login, m.requester.login)) return notSubmitted('requester_changed', `The plan was made for ${m.requester.login} but StartRight is signed in as ${s.requester.login}.`);

  const { match } = await memberOrg(s, m.org);
  if (!match) return notSubmitted('not_a_member', `You are no longer a member of ${m.org}.`);
  const a = await s.api('availability', { query: { organization: m.org, name: m.repo.name } });
  if (!a.ok || !a.body.available) return notSubmitted('name_unavailable', `${m.org}/${m.repo.name} is no longer available (it may already exist: run status).`);
  if (m.ownership.type === 'serviceTree') {
    const r = await s.api('restriction', { query: { organization: m.org, serviceTreeId: m.ownership.serviceTreeId } });
    if (!r.ok || r.body.blocked) return notSubmitted('service_restricted', r.body?.message ?? 'New repositories are no longer allowed for this Service Tree entry.');
  }

  const refs = { ownership: {}, acl: {} };
  for (const [purpose, list, into] of [['ownership', m.ownership.owners ?? [], refs.ownership], ['acl', m.access, refs.acl]]) {
    for (const entry of list) {
      const fresh = await refindPrincipal(s, { org: m.org, purpose, entry });
      if (!fresh) return notSubmitted('principal_changed', `${entry.displayName} could not be found again in StartRight. Re-run plan.`);
      into[entry.principalId] = fresh.principalRef;
    }
  }
  const body = buildBody(m, refs);
  const drift = bodyDiffersFromPlan(body, m, refs);
  if (drift.length) return notSubmitted('plan_mismatch', `The request does not match the accepted plan (${drift.join(', ')}).`);
  const shape = validate(CreateBody, body);
  if (shape.length) return notSubmitted('validation_failed', `The request is not valid: ${shape.slice(0, 3).join('; ')}`);

  const key = requestKey({ org: m.org, name: m.repo.name });
  const repo = `${m.org}/${m.repo.name}`;
  const lock = acquireSubmitLock(dir, key, { planId: plan.planId, repo, requester: m.requester.login });
  let res;
  try {
    res = await s.create(body, { beforeSend: () => markSent(lock) });
  } catch (e) {
    // Nothing left the machine: the journal slot goes back to empty so the request can be planned again.
    if (lock.record.state === 'prepared') { try { releaseUnsent(dir, key); } catch {} }
    throw e;
  }
  if (!res.sent) {
    if (res.notDelivered) {
      recordOutcome(lock, { outcome: 'rejected', reason: 'not_delivered', error: res.error });
      return notSubmitted('not_delivered', `StartRight could not be reached (${res.errorCode ?? res.error}); nothing was created.`);
    }
    recordOutcome(lock, { outcome: 'unknown', error: res.error });
    return { outcome: 'unknown', repo, message: `The request was sent but no answer arrived (${res.error}). The repository may exist.` };
  }
  return settle(lock, res, repo);
}

function problemView(res) {
  const b = res.body && typeof res.body === 'object' ? res.body : {};
  return { status: res.status, title: b.title, detail: b.detail ?? b.message, correlationId: b.correlationId, retryable: b.retryable, operationId: res.operationId };
}

function settle(lock, res, repo) {
  const chk = checkResponse('create', res.status, res.body);
  const c = classifyCreate(res.status, res.body);
  // Anything outside the contract (an unexpected status, or a malformed body on a failure) cannot prove that nothing
  // was created, so only a documented answer ever frees the journal.
  if (!chk.ok && c.outcome !== 'success') {
    recordOutcome(lock, { outcome: 'unknown', status: res.status });
    return { outcome: 'unknown', repo, status: res.status, message: `StartRight answered ${res.status} in a form the skill does not recognize. The repository may exist.`, contractErrors: chk.errors.slice(0, 3), operationId: res.operationId };
  }
  if (c.outcome === 'success') {
    const b = chk.ok ? res.body : {};
    const out = { repo: b.organization && b.name ? `${b.organization}/${b.name}` : repo, webUrl: b.webUrl ?? null, id: b.id ?? null };
    recordOutcome(lock, { outcome: 'success', ...out });
    return { outcome: 'success', ...out, operationId: res.operationId, ...(chk.ok ? {} : { contractWarning: chk.errors.slice(0, 3) }), note: WARN.propagation.message };
  }
  if (c.outcome === 'partial') {
    const r = res.body.repository;
    recordOutcome(lock, { outcome: 'partial', repositoryOutcome: c.repositoryOutcome, failedStage: c.failedStage, repo: r ? `${r.organization}/${r.name}` : repo });
    return { outcome: 'partial', repo, repositoryOutcome: c.repositoryOutcome, failedStage: c.failedStage, remediation: c.remediation, ...(r ? { repository: r } : {}), correlationId: res.body.correlationId, operationId: res.operationId, message: 'StartRight reported a partial failure. Do NOT resubmit; follow the remediation.' };
  }
  if (c.outcome === 'rejected') {
    recordOutcome(lock, { outcome: 'rejected', reason: c.reason, status: res.status });
    return { outcome: 'rejected', reason: c.reason, retryable: !!c.retryable, problem: problemView(res), repo };
  }
  recordOutcome(lock, { outcome: 'unknown', status: res.status });
  return { outcome: 'unknown', repo, status: res.status, problem: problemView(res), message: `StartRight answered ${res.status}. The repository may exist.` };
}

// ---------------------------------------------------------------- status / options
function journalView(rec) {
  return rec && { repo: rec.repo ?? null, state: rec.state, outcome: rec.outcome ?? null, sentAt: rec.sentAt ?? null, ...(rec.webUrl ? { webUrl: rec.webUrl } : {}), ...(rec.failedStage ? { failedStage: rec.failedStage } : {}) };
}

export function listJournal(dir) {
  try {
    return readdirSync(join(dir, 'locks')).filter((f) => /^submit-.*\.json$/.test(f)).flatMap((f) => { try { return [journalView(JSON.parse(readFileSync(join(dir, 'locks', f), 'utf8')))]; } catch { return []; } });
  } catch { return []; }
}

export async function runStatus(s, { repo, dir }) {
  s.guard.setPhase('status');
  await begin(s);
  const recent = (await s.api('recent')).body;
  if (!repo) return { ok: true, recent: recent.slice(0, 10), journal: listJournal(dir), note: 'recent lists newly created repositories visible to StartRight, not only yours.' };
  const [org, name] = repo.split('/');
  const hit = recent.find((r) => sameOrg(r.organization, org) && sameOrg(r.name, name));
  const av = await s.api('availability', { query: { organization: org, name } });
  const nameTaken = av.ok ? !av.body.available : null;
  const journal = journalView(readLock(dir, requestKey({ org, name })));
  return { ok: true, found: !!hit || nameTaken === true, repo: hit ?? null, nameTaken, journal };
}

export async function runOptions(s, { org, findService, findPrincipal, purpose, showTeam, graph }) {
  s.guard.setPhase('options');
  await begin(s);
  const { orgs, match } = await memberOrg(s, org);
  const out = { ok: true, organizations: orgs.map((o) => o.login) };
  if (showTeam) {
    if (!match) throw new SkillError('bad_args', '--show-team needs --org <an organization you belong to>.');
    const ctx = graph ? await loadOrgContext(graph, aliasOf(s.requester.login)) : { ok: false, code: 'graph_unavailable', message: 'Microsoft Graph is not configured.' };
    if (!ctx.ok) out.team = { available: false, reason: ctx.code, message: ctx.message };
    else {
      const view = async (person) => ({ displayName: person.displayName, email: person.email, githubHandle: person.githubHandle, inOrganization: !!(await findStartRightUser(s, { org: match.login, purpose: 'acl', person })) });
      out.team = { available: true, organization: match.login, manager: await view(ctx.manager), members: [], defaultRole: DEFAULT_TEAM_ROLE, tooLarge: ctx.peers.length > TEAM_LIMIT };
      for (const peer of ctx.peers.slice(0, TEAM_LIMIT)) out.team.members.push(await view(peer));
    }
  }
  if (findService) {
    const cat = await s.api('catalog');
    const r = searchCatalog(cat.body, findService);
    out.services = r.exact.length ? { exact: r.exact } : { exact: [], near: r.near };
  }
  if (findPrincipal) {
    if (!match) throw new SkillError('bad_args', '--find-principal needs --org <an organization you belong to>.');
    const list = await lookupPrincipals(s, { org: match.login, purpose: purpose ?? 'acl', query: findPrincipal });
    out.principals = list.slice(0, 15).map(candidateView);
  }
  return out;
}

export { aliasOf };
