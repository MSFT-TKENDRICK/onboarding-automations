#!/usr/bin/env node
// StartRight new-repository driver. JSON on stdout; diagnostics on stderr with --verbose.
//   plan    : resolve and validate everything read-only, read the terms, save a plan. Never creates anything.
//   submit  : re-verify a saved plan and create the repository exactly once (requires --plan and --accept-terms <sha>).
//   status  : is the repository there (recent list + name availability + this machine's journal)?
//   options : your organizations, Service Tree lookups, people/group lookups.
//   verify  : maintainers: prove the recorded API contract against the live service, read-only.
import { parseArgs } from 'node:util';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSession, SkillError, STARTRIGHT_URL } from './lib/client.mjs';
import { runVerify } from './lib/verify.mjs';
import { createGraph } from './lib/graph.mjs';
import { normalizeInput, localCheck, runPlan, runSubmit, runStatus, runOptions, termsView } from './lib/flows.mjs';
import { stateDir, savePlan, loadPlan, readLock, requestKey, planId } from './lib/plan-store.mjs';
import { killAllBrowsers } from './lib/browser.mjs';

export const HELP = `Usage:
  node startright-repo.mjs plan    [inputs] [common]   Resolve and validate a new-repository request against StartRight
                                                       (read-only), read the terms, save a plan. Never creates anything.
  node startright-repo.mjs options [--org <org>] [--find-service <text>] [--find-principal <text>] [--purpose acl|ownership] [--show-team] [common]
  node startright-repo.mjs submit  --plan <planId> --accept-terms <terms.sha> [common]
  node startright-repo.mjs status  [--repo <org>/<name>] [common]
  node startright-repo.mjs verify  [common]            Maintainers: prove the recorded API contract against the live
                                                       service, read-only (references/STARTRIGHT.md). Never creates.

Inputs (plan):
  --org <login>                  owner organization (one you belong to)
  --name <repo>                  repository name (letters, digits . _ -; at most 100)
  --description <text>           required, at most 350 characters
  --visibility internal|private  default internal
  --classification non-production   REQUIRED, no default. Production, TCB and HVT are refused (use Proxima / Azure DevOps).
  Ownership, exactly one of:
    --service-tree <guid>        Service Tree id
    --service-tree-name <name>   exact Service Tree name (ambiguity is returned as candidates, never picked)
    --direct-owner <person>      one other owner (you are added as the second); repeatable, at most 2 in total
  Access:
    --access <person-or-group>=<read|triage|write|maintain>   repeatable. You are added with maintain. At least one group,
                                 or two people, must have maintain. People are matched exactly (e-mail, alias, full name).
  Manager and team defaults (read from Microsoft Graph via your signed-in Azure CLI; see references/CLI.md):
    With no ownership given, your manager is the second direct owner (and gets maintain), and everyone else who reports to
    your manager is added as a team member (GitHub handle <alias>_microsoft, matched in StartRight by exact e-mail).
    --team-role <read|triage|write>   role for the default team (default write)
    --team-group <group>         use an Entra group as the default team instead of adding the people one by one. Only
                                 accepted when Graph shows it holds nobody but your manager's team (options --show-team lists
                                 candidates); a new group can take 5-6 hours to reach GitHub.
    --no-default-team            do not add the people who report to your manager
    --no-manager-owner           do not default your manager as co-owner
  --json <file|->                the same inputs as one JSON object (flags override it)

Submit (creates the repository once; only after the user explicitly accepted the plan's full terms):
  --plan <planId>                from a ready plan; expires after 30 minutes
  --accept-terms <terms.sha>     the terms.sha of that plan

Common:
  --headed                       visible browser so the user can finish sign-in (after auth_required)
  --ephemeral                    throwaway browser profile for this run
  --browser <path>               Chromium-family browser (default: Edge, then Chrome; env STARTRIGHT_BROWSER)
  --verbose                      diagnostics on stderr
  --pretty                       indented JSON
  -h, --help                     this text

Output: one JSON object on stdout. Follow its "next" hint.
Exit codes: 0 the command worked (not proof a repository exists), 2 needs action or nothing was created
  (verify: a check failed), 3 outcome unknown or partial (never resubmit), 1 error.

Examples:
  node startright-repo.mjs plan --org gim-home --name my-sandbox --description "Scratch repo" --classification non-production --direct-owner alias@microsoft.com
  node startright-repo.mjs submit --plan <planId> --accept-terms <terms.sha>
  node startright-repo.mjs status --repo gim-home/my-sandbox

Reference: references/CLI.md`;

const TRANSIENT = new Set(['guard_unavailable', 'navigation_failed', 'browser_unresponsive', 'cdp_timeout', 'session_expired', 'startright_unreachable', 'error']);
const REPLAN = 'Re-run plan, present the new plan and its full terms, and ask the user again.';

export function nextHint(cmd, out) {
  if (!out || (out.usage && out.ok !== false)) return undefined;
  if (out.ok === false && out.error) {
    const e = out.error;
    if (e === 'bad_args') return 'Fix the command: see --help or references/CLI.md.';
    if (e === 'auth_required') return 'Re-run the same command with --headed and let the user finish sign-in (and the one-time GitHub authorization of the StartRight app) in the browser window. Never ask for credentials.';
    if (e === 'non_microsoft_account') return 'Tell the user StartRight needs their Microsoft EMU account (<alias>_microsoft), and stop.';
    if (e === 'startright_unreachable') return 'Ask the user to connect to the corporate network or VPN, then re-run. Nothing was created.';
    if (e === 'plan_invalid' || e === 'plan_mismatch') return REPLAN;
    if (e === 'terms_not_accepted') return "Show the user this plan's full terms; pass its terms.sha only after they explicitly accept.";
    if (e === 'already_submitted') return 'Do not retry: report previous and run status --repo <org>/<name>.';
    if (e === 'contract_violation' || e === 'request_contract_violation') return 'StartRight no longer matches the skill\'s recorded contract. Nothing was created. Report it to the skill maintainers (references/DRIFT.md) and stop.';
    if (e === 'test_environment_refuses_live_write') return 'A test run tried to write to a non-local service and was refused. Nothing was created.';
    if (TRANSIENT.has(e)) return `Retry the same command once${cmd === 'submit' ? ' (show the user the terms again and get their acceptance first; the journal refuses anything already sent)' : ''}. If it fails again, report it and stop.`;
    return 'Report the message to the user and stop.';
  }
  if (cmd === 'plan') {
    if (out.status === 'ready') {
      return `Show the user the resolved and defaulted values, every warning and the full terms. Only after they explicitly accept these terms: node startright-repo.mjs submit --plan ${out.planId} --accept-terms ${out.terms?.sha ?? '<terms.sha>'}`;
    }
    if (out.status === 'needs_input') return 'Ask the user for each missing entry (offer its options or candidates; never pick a person or value yourself), then re-run plan with the same flags plus the answers.';
    if (out.status === 'invalid') return 'Show each errors entry (with its candidates or suggestion) and ask the user; re-run plan with their corrected values. Never pick a candidate yourself.';
    if (out.status === 'blocked') return "Report each blocker's message and links to the user and stop. Do not work around it (production, TCB and HVT go to Proxima or Azure DevOps).";
    return undefined;
  }
  if (cmd === 'submit') {
    if (out.outcome === 'success') return `Report ${out.repo}${out.webUrl ? ` (${out.webUrl})` : ''} to the user, and mention that permissions can take about a minute to propagate.`;
    if (out.outcome === 'rejected') return `Nothing was created. Show the problem (title, detail, correlationId) verbatim${out.retryable ? '; it is marked retryable: run status first, and only if the repository is absent re-plan, show the terms and get acceptance again' : ', fix the values with the user, then re-run plan'}.`;
    if (out.outcome === 'partial') return 'Do NOT resubmit. Report the repository outcome, failed stage and remediation to the user (contact gim@microsoft.com / https://aka.ms/gim/ops with the correlationId if needed) and run status.';
    if (out.outcome === 'unknown') return `Do NOT resubmit. Tell the user the repository may exist; run status --repo ${out.repo} in a minute and report what it shows.`;
    if (out.outcome === 'not_submitted') {
      if (['plan_mismatch', 'principal_changed', 'requester_changed', 'validation_failed'].includes(out.reason)) return `Nothing was created. ${REPLAN}`;
      if (['name_unavailable', 'not_a_member', 'service_restricted'].includes(out.reason)) return 'Nothing was created. Report the message to the user; fix the cause with them and re-plan.';
      return 'Nothing was created. Report the message. To retry, show the user the terms again, get their explicit acceptance, and run the same submit once.';
    }
    return undefined;
  }
  if (cmd === 'status' && out.found === false) return 'The repository is not visible yet: tell the user and check again later. Never resubmit because of it.';
  if (cmd === 'verify') {
    if (!out.ok) return `Report ${(out.checks ?? []).filter((c) => c.pass !== true).map((c) => c.id).join(', ') || 'the result'} with its evidence to the skill maintainers. Nothing was created.`;
    if (out.live === false) return 'Every check passed, but against STARTRIGHT_URL, not the live service: this proves nothing about the live service.';
  }
  return undefined;
}

const EXIT = { ready: 0, success: 0, ok: 0, needs_input: 2, invalid: 2, blocked: 2, not_submitted: 2, rejected: 2, unknown: 3, partial: 3, error: 1 };
const PLAN_TTL_MS = 30 * 60 * 1000;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      org: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, visibility: { type: 'string' }, classification: { type: 'string' },
      'service-tree': { type: 'string' }, 'service-tree-name': { type: 'string' }, 'direct-owner': { type: 'string', multiple: true }, access: { type: 'string', multiple: true }, json: { type: 'string' },
      plan: { type: 'string' }, 'accept-terms': { type: 'string' }, repo: { type: 'string' },
      'find-service': { type: 'string' }, 'find-principal': { type: 'string' }, purpose: { type: 'string' }, 'show-team': { type: 'boolean' },
      'team-role': { type: 'string' }, 'team-group': { type: 'string' }, 'no-default-team': { type: 'boolean' }, 'no-manager-owner': { type: 'boolean' },
      headed: { type: 'boolean' }, ephemeral: { type: 'boolean' }, browser: { type: 'string' }, verbose: { type: 'boolean' }, pretty: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  return { cmd: positionals[0], extra: positionals.slice(1), v: values };
}

function readInput(v, stdinText) {
  let raw = {};
  if (v.json) {
    const j = JSON.parse(v.json === '-' ? stdinText() : readFileSync(v.json, 'utf8'));
    raw = { ...j, owners: j.owners ?? j.directOwners, access: j.access };
  }
  const flags = { org: v.org, name: v.name, description: v.description, visibility: v.visibility, classification: v.classification, serviceTree: v['service-tree'], serviceTreeName: v['service-tree-name'] };
  for (const [k, val] of Object.entries(flags)) if (val !== undefined) raw[k] = val;
  if (v['direct-owner']?.length) raw.owners = v['direct-owner'];
  if (v.access?.length) raw.access = v.access;
  if (v['team-role'] !== undefined) raw.teamRole = v['team-role'];
  if (v['team-group'] !== undefined) raw.teamGroup = v['team-group'];
  if (v['no-default-team']) raw.noDefaultTeam = true;
  if (v['no-manager-owner']) raw.noManagerOwner = true;
  return normalizeInput(raw);
}

const plansView = (r) => {
  const ready = r.status === 'ready';
  return {
    status: r.status, resolved: r.resolved ?? undefined, defaulted: r.defaulted, missing: r.missing, errors: r.errors, blockers: r.blockers, warnings: r.warnings, references: r.references,
    terms: ready ? termsView() : { sha: termsView().sha, text: `${termsView().text.slice(0, 200)}…` },
  };
};

export async function run(argv, opts = {}) {
  const ctx = {};
  const { code, out } = await execute(argv, opts, ctx);
  const next = out?.next ?? nextHint(ctx.cmd, out);
  return { code, out: next ? { ...out, next } : out };
}

async function execute(argv, { env = process.env, stdinText = () => readFileSync(0, 'utf8') } = {}, ctx = {}) {
  let parsed;
  try { parsed = parse(argv); } catch (e) { return { code: 1, out: { ok: false, error: 'bad_args', message: e.message, usage: HELP } }; }
  const { cmd, v } = parsed;
  ctx.cmd = cmd;
  if (v.help || !cmd) return { code: v.help ? 0 : 1, out: { usage: HELP } };
  if (!['plan', 'submit', 'status', 'options', 'verify'].includes(cmd)) return { code: 1, out: { ok: false, error: 'bad_args', message: `Unknown command ${cmd}`, usage: HELP } };
  const baseUrl = new URL(env.STARTRIGHT_URL || STARTRIGHT_URL).origin;
  const dir = stateDir(env);
  const logFile = env.STARTRIGHT_LOG_FILE;
  const log = (m) => {
    if (v.verbose) process.stderr.write(`[startright] ${m}\n`);
    if (logFile) try { appendFileSync(logFile, `${new Date().toISOString()} ${cmd} ${m}\n`); } catch {}
  };

  let input;
  let local;
  let plan;
  try {
    if (parsed.extra.length) throw new SkillError('bad_args', `Unexpected argument ${parsed.extra[0]}`);
    if (cmd === 'plan') {
      input = readInput(v, stdinText);
      local = localCheck(input);
      if (local.errors.length || local.blockers.length) {
        const status = local.blockers.length ? 'blocked' : 'invalid';
        return { code: EXIT[status], out: { ok: false, status, defaulted: local.defaulted, missing: local.missing, errors: local.errors, blockers: local.blockers, warnings: [], browser: 'not opened' } };
      }
    }
    if (cmd === 'submit') {
      if (!v.plan || !v['accept-terms']) throw new SkillError('bad_args', 'submit requires --plan <planId> and --accept-terms <termsSha> from a ready plan.');
      try { plan = loadPlan(dir, v.plan); } catch (e) { throw new SkillError('plan_invalid', e.message); }
      if (plan.baseUrl !== baseUrl) throw new SkillError('plan_mismatch', 'Plan was created for a different StartRight URL.');
      if (v['accept-terms'] !== plan.terms.sha) throw new SkillError('terms_not_accepted', 'The --accept-terms value does not match the terms shown in the plan. Show the terms to the user and pass the exact sha they accepted.');
      const m = plan.material;
      const prior = readLock(dir, requestKey({ org: m.org, name: m.repo.name }));
      const reopenable = prior?.state === 'reconciled' && prior.outcome === 'rejected';
      if (prior && !reopenable && prior.state !== 'prepared') {
        return { code: EXIT.error, out: { ok: false, error: 'already_submitted', message: `This repository was already ${prior.state}${prior.repo ? ` (${prior.repo})` : ''}${prior.outcome ? `: ${prior.outcome}` : ''}. Refusing to submit again; run status.`, previous: { state: prior.state, outcome: prior.outcome ?? null, repo: prior.repo ?? null } } };
      }
    }
    if (cmd === 'status' && v.repo && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v.repo)) throw new SkillError('bad_args', '--repo expects <org>/<name>.');
    if (cmd === 'verify' && Object.keys(v).some((k) => !['headed', 'ephemeral', 'browser', 'verbose', 'pretty', 'help'].includes(k))) throw new SkillError('bad_args', 'verify takes only the common flags.');
    if (cmd === 'options' && v.purpose && !['acl', 'ownership'].includes(v.purpose)) throw new SkillError('bad_args', '--purpose must be acl or ownership.');
  } catch (e) {
    return { code: 1, out: { ok: false, error: e.code ?? 'bad_args', message: e.message } };
  }

  const t0 = performance.now();
  const authTimeoutMs = Number(env.STARTRIGHT_AUTH_TIMEOUT_MS) > 0 ? Number(env.STARTRIGHT_AUTH_TIMEOUT_MS) : undefined;
  let s;
  try {
    s = await openSession({
      baseUrl, headless: !v.headed, browserPath: v.browser, authTimeoutMs, env, log,
      profileDir: v.ephemeral || env.STARTRIGHT_EPHEMERAL === '1' ? undefined : (env.STARTRIGHT_PROFILE_DIR || join(dir, 'profile')),
      allowSubmit: cmd === 'submit',
    });
    const ms = () => Math.round(performance.now() - t0);
    if (cmd === 'verify') {
      const res = await runVerify(s, { baseUrl });
      return { code: res.ok ? 0 : 2, out: { ...res, ms: ms() } };
    }
    if (cmd === 'status') {
      const res = await runStatus(s, { repo: v.repo, dir });
      return { code: v.repo && !res.found ? 2 : 0, out: { ...res, ms: ms() } };
    }
    if (cmd === 'options') return { code: 0, out: { ...(await runOptions(s, { org: v.org, findService: v['find-service'], findPrincipal: v['find-principal'], purpose: v.purpose, showTeam: v['show-team'], graph: createGraph({ env, log }) })), ms: ms() } };
    if (cmd === 'plan') {
      const r = await runPlan(s, input, local, { graph: createGraph({ env, log }) });
      const out = { ok: r.status === 'ready', ...plansView(r), ms: ms() };
      if (r.status === 'ready') {
        const id = planId(r.material);
        const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString();
        savePlan(dir, { planId: id, createdAt: new Date().toISOString(), expiresAt, baseUrl, material: r.material, terms: { sha: termsView().sha } });
        Object.assign(out, { planId: id, expiresAt });
      }
      return { code: EXIT[r.status] ?? 1, out };
    }
    const res = await runSubmit(s, plan, { dir });
    return { code: EXIT[res.outcome] ?? 1, out: { ok: res.outcome === 'success', ...res, ms: ms() } };
  } catch (e) {
    const code = e.code === 'ALREADY_SUBMITTED' ? 'already_submitted' : e.code ?? 'error';
    return { code: EXIT.error, out: { ok: false, error: code, message: e.message, ...(e.lock ? { previous: { state: e.lock.state, outcome: e.lock.outcome ?? null, repo: e.lock.repo ?? null } } : {}), ...(e.errors ? { contractErrors: e.errors } : {}), ...(e.endpoint ? { endpoint: e.endpoint } : {}) } };
  } finally {
    await s?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.once(sig, () => { killAllBrowsers(); process.exit(130); }); } catch {}
  }
  const argv = process.argv.slice(2);
  const { code, out } = await run(argv);
  process.stdout.write(`${JSON.stringify(out, null, argv.includes('--pretty') ? 2 : 0)}\n`);
  process.exitCode = code;
}
