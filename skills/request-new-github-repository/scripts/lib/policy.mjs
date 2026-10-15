// Static policy: the terms the user must accept, the production/TCB/HVT hard stop, and input validation that mirrors
// the StartRight wizard's own client-side rules (see references/POLICY.md for the sources).
import { sha256 } from './plan-store.mjs';
import { LIMITS, REPO_NAME, VISIBILITIES, ROLES, isGuid } from './contract.mjs';

export const LINKS = {
  proxima: 'https://eng.ms/docs/more/github-inside-microsoft/overview/proxima',
  gim: 'https://eng.ms/docs/more/github-inside-microsoft/overview',
  policyService: 'https://eng.ms/docs/more/github-inside-microsoft/policies/index.html',
  accessControl: 'https://eng.ms/docs/more/github-inside-microsoft/policies/access.html',
  exampleRepo: 'https://github.com/gim-home/us-ss-fis-onboarding',
  startright: 'https://startright.app.prod.gitops.startclean.microsoft.com/web/emu/',
  support: 'mailto:gim@microsoft.com',
};

const TERMS_LINES = [
  'You are asking StartRight (GitHub inside Microsoft) to create a NEW repository in a Microsoft GitHub EMU organization right now. The repository is created immediately; this skill cannot delete or undo it.',
  'This repository is NON-PRODUCTION. GitHub EMU is not allowed for production services, Trusted Computing Base (TCB) or High Value Target (HVT) code. Those belong in GitHub Proxima (msft.ghe.com) or Azure DevOps. New non-production repositories are encouraged to start in Proxima.',
  'The accountable owners are the Service Tree service or the two direct owners shown in this plan. The listed people and groups receive exactly the listed repository permissions.',
  'Microsoft security and compliance policy applies: a secret scan runs on the new repository and results are emailed to you, and the repository stays subject to GitHub inside Microsoft governance.',
  'Do not request repositories speculatively or in bulk: each request is audited, and repeated or policy-violating requests are flagged.',
];
export const TERMS = { text: TERMS_LINES.join('\n'), links: [LINKS.proxima, LINKS.gim], sha: sha256(`${TERMS_LINES.join('\n')}\n${LINKS.proxima}\n${LINKS.gim}`).slice(0, 16) };

export const PROXIMA_GUIDANCE = `GitHub EMU only hosts non-production repositories. For production, TCB or HVT code use GitHub Proxima (https://msft.ghe.com, request the "Team Contributors" access package from https://aka.ms/join/esme) or Azure DevOps. Docs: ${LINKS.proxima}. Support: gim@microsoft.com or https://aka.ms/gim/ops.`;

export const WARN = {
  prefer_proxima: { code: 'prefer_proxima', message: `GiM guidance: new repositories that are not TCB/HVT should preferably start in GitHub Proxima rather than EMU. ${LINKS.proxima}` },
  secret_scan: { code: 'secret_scan', message: 'A secret scan runs when the repository is created and its results are emailed to the requester.' },
  group_delay: { code: 'group_sync_delay', message: 'A newly created Entra group can take 5-6 hours to appear in GitHub. Add individual users as well if access is needed immediately.' },
  propagation: { code: 'propagation_delay', message: 'Permissions take up to about a minute to propagate; the new repository may return 404 briefly.' },
};

// --classification: required, no default. Only an explicit "non-production" proceeds.
const NONPROD = new Set(['non-production', 'nonproduction', 'non_production', 'nonprod', 'non-prod']);
const BLOCKED_CLASS = new Set(['production', 'prod', 'tcb', 'hvt', 'production-tcb', 'production-hvt']);
export function classify(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { kind: 'missing' };
  const v = String(value).trim().toLowerCase();
  if (NONPROD.has(v)) return { kind: 'nonproduction' };
  if (BLOCKED_CLASS.has(v) || /production|tcb|hvt/.test(v)) return { kind: 'blocked' };
  return { kind: 'invalid' };
}

export const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
export const normName = (s) => String(s ?? '').trim();

// Validates only what the wizard validates; nothing is silently "fixed" (the UI replaces illegal characters with "-",
// which would change the name the user asked for, so it is reported instead).
export function validateRepo({ org, name, description, visibility }) {
  const errors = [];
  const add = (code, field, message, extra = {}) => errors.push({ code, field, message, ...extra });
  if (!org) add('org_required', 'org', 'Choose the owner organization (--org).');
  else if (org.length > LIMITS.org || !ORG.test(org)) add('org_invalid', 'org', `"${org}" is not a valid GitHub organization login (letters, digits and hyphens, at most ${LIMITS.org}).`);
  if (!name) add('name_required', 'name', 'Give the repository a name (--name).');
  else if (name === '.' || name === '..') add('name_invalid', 'name', 'A repository cannot be named "." or "..".');
  else if (name.length > LIMITS.name) add('name_too_long', 'name', `The repository name is longer than ${LIMITS.name} characters.`);
  else if (!REPO_NAME.test(name)) add('name_invalid', 'name', 'Repository names may contain only letters, digits, ".", "_" and "-".', { suggestion: name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || undefined });
  if (!description) add('description_required', 'description', 'A description is required (--description, at most 350 characters).');
  else if (description.length > LIMITS.description) add('description_too_long', 'description', `The description is ${description.length} characters; the limit is ${LIMITS.description}.`);
  if (!visibility) add('visibility_required', 'visibility', 'Choose the visibility (--visibility internal|private).');
  else if (!VISIBILITIES.includes(visibility)) add('visibility_invalid', 'visibility', `Visibility must be ${VISIBILITIES.join(' or ')}.`);
  return errors;
}

// The Access Control policy (.github/acl/access.yml) names its roles Read, Pull, Triage, Write, Push and Maintain; pull
// and push are the GitHub names for read and write. Admin cannot be granted by an ACL (it is requested through JIT).
const ROLE_ALIASES = { pull: 'read', push: 'write' };
export const isAdminRole = (text) => String(text ?? '').trim().toLowerCase() === 'admin';
export function parseRole(text) {
  const r = String(text ?? '').trim().toLowerCase();
  const role = ROLE_ALIASES[r] ?? r;
  return ROLES.includes(role) ? role : null;
}

// Access rule the service enforces: at least one group, or at least two users, must hold Maintain; and the requester
// must hold Maintain themselves. entries: [{ principalId, type, role }]
export function accessErrors(entries, requesterId) {
  const errors = [];
  if (!entries.length) return [{ code: 'access_required', message: 'Add at least one access entry.' }];
  const maintainers = entries.filter((e) => e.role === 'maintain');
  if (!(maintainers.some((e) => e.type === 'group') || maintainers.filter((e) => e.type === 'user').length >= 2)) {
    errors.push({ code: 'maintain_rule', message: 'At least one group, or at least two users, must have the maintain role.' });
  }
  const me = entries.find((e) => e.principalId === requesterId);
  if (!me || me.role !== 'maintain') errors.push({ code: 'requester_must_maintain', message: 'The requester must be in the access list with the maintain role.' });
  const seen = new Set();
  for (const e of entries) { if (seen.has(e.principalId)) errors.push({ code: 'access_duplicate', message: `${e.displayName ?? e.principalId} is listed more than once.` }); seen.add(e.principalId); }
  return errors;
}

export { isGuid };
