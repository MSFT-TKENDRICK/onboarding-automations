#!/usr/bin/env node
// MCAPS new Azure subscription request driver. JSON on stdout; diagnostics on stderr with --verbose.
//   plan    : fill the live form (writes blocked), resolve values, check eligibility, read terms. Never submits.
//   submit  : re-verify a saved plan and submit exactly once (requires --plan and --accept-terms <sha>).
//   status  : list your recent requests (or one --case) from the portal Web API.
//   options : show the currently visible fields and option lists for the given selections.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSession, openForm, fill, submit, ownRequests, findDuplicates, planMaterial, normalizeInput, DEFAULT_FORM_URL, SkillError } from './lib/portal.mjs';
import { stateDir, savePlan, loadPlan, readLock, requestKey, planId as hashPlan } from './lib/plan-store.mjs';
import { systemTimeZone } from './lib/defaults.mjs';
import { killAllBrowsers } from './lib/browser.mjs';
import { createSystemOne } from './lib/systemone.mjs';

export const HELP = `Usage:
  node mcaps-subscription.mjs plan    [inputs] [common]   Fill the live form with writes blocked, resolve every value,
                                                          check eligibility, read the terms, save a plan. Never submits.
  node mcaps-subscription.mjs options [inputs] [common]   Show the visible fields and current options. Saves nothing.
  node mcaps-subscription.mjs submit  --plan <planId> --accept-terms <terms.sha> [--allow-duplicate] [common]
  node mcaps-subscription.mjs status  [--case REQ-123456-2026] [common]

Inputs (plan, options). All optional; applied defaults are listed in "defaulted":
  --title <text>                 default "<owner alias> Azure subscription <YYYY-MM-DD>" (max 256 characters)
  --purpose <text>               default: the only option, if there is exactly one
  --type internal|external       default internal; asked for when a --tenant-* value is given
  --owner <alias|email|name>     default: the signed-in user (matched exactly, never partially)
  --allowance <amount>           default: the highest monthly allowance offered
  --timezone <zone>              default: MCAPS_TIMEZONE, else this computer's zone
                                 ("Pacific Time", America/Los_Angeles or UTC-08:00)
  --tenant-type <text>           external only; default: the only option, if there is exactly one
  --tenant-licensing <text>      external only; default: the only option, if there is exactly one
  --tenant-name <text>           external only (max 50 characters)
  --field <id>=<value>           repeatable: a required field the portal added (unknown_required_field)
  --map <slot>=<id>              repeatable: only for the control the user confirmed from a field_drift entry
                                 slots: title purpose type allowance timezone tenantType tenantLicensing tenantName
  --json <file|->                the same inputs as one JSON object (flags override it)
  --no-defaults                  apply no defaults: every value not given is reported in "missing"
  --full-terms                   include the full terms text even when the plan is not ready

Submit (sends the request once; only after the user explicitly accepted the plan's full terms):
  --plan <planId>                from a ready plan; expires after 30 minutes
  --accept-terms <terms.sha>     the terms.sha of that plan
  --allow-duplicate              only when the user explicitly asked for another request with the same title

Status:
  --case REQ-123456-2026         only this request (default: your 10 most recent requests)

Common:
  --headed                       visible browser so the user can finish sign-in (after auth_required)
  --ephemeral                    throwaway browser profile for this run
  --browser <path>               Chromium-family browser (default: Edge, then Chrome; env MCAPS_BROWSER)
  --verbose                      diagnostics on stderr
  --pretty                       indented JSON
  -h, --help                     this text

Output: one JSON object on stdout. Follow its "next" hint.
Exit codes: 0 the command worked (not proof a request exists), 2 needs action or nothing was submitted,
  3 submit outcome unknown (never resubmit), 1 error.

Examples:
  node mcaps-subscription.mjs plan
  node mcaps-subscription.mjs plan --purpose "Hybrid" --owner alias@microsoft.com --allowance 500
  node mcaps-subscription.mjs submit --plan <planId> --accept-terms <terms.sha>
  node mcaps-subscription.mjs status --case REQ-123456-2026

Reference: references/CLI.md`;

const TRANSIENT = new Set(['guard_unavailable', 'form_lost', 'navigation_failed', 'portal_timeout', 'browser_unresponsive', 'cdp_timeout', 'api_failed', 'contact_unknown', 'error']);
const REPLAN = 'Re-run plan, present the new plan and its full terms, and ask the user again.';
const RETRY_SUBMIT = 'To retry, show the user the terms again, get their explicit acceptance, and run the same submit once.';

// What the agent should do next with a result (mirrors SKILL.md). Undefined when no follow-up is needed.
export function nextHint(cmd, out) {
  if (!out || (out.usage && out.ok !== false)) return undefined;
  if (out.ok === false && out.error) {
    const e = out.error;
    if (e === 'bad_args') return 'Fix the command: see --help or references/CLI.md.';
    if (e === 'invalid_mapping') return 'Drop the --map, or use only a control the user approved from a field_drift entry.';
    if (e === 'auth_required') return 'Re-run the same command with --headed and let the user finish sign-in in the browser window. Never ask for credentials.';
    if (e === 'vpn_required' || e === 'portal_unreachable') return 'Ask the user to connect to the corporate network or VPN, then re-run. Nothing was submitted.';
    if (e === 'non_microsoft_account') return 'Tell the user to sign in with their Microsoft corporate account, and stop.';
    if (e === 'no_eligible_purpose') return 'Report the portal messages to the user and stop.';
    if (e === 'plan_invalid' || e === 'plan_mismatch') return REPLAN;
    if (e === 'terms_not_accepted') return "Show the user this plan's full terms; pass its terms.sha only after they explicitly accept.";
    if (e === 'already_submitted') return `Do not retry: report previous and run status.${out.previous?.outcome === 'success' ? ' Only if the user explicitly wants a second identical subscription: re-plan, present it with its terms, get acceptance and submit with --allow-duplicate.' : ''}`;
    if (TRANSIENT.has(e)) return `Retry the same command once${cmd === 'submit' ? ' (show the user the terms again and get their acceptance first; the journal refuses anything already sent)' : ''}. If it fails again, report it and stop.`;
    return 'Report the message to the user and stop.';
  }
  if (cmd === 'plan') {
    const codes = (list) => new Set((list ?? []).map((x) => x.code));
    if (out.status === 'ready') {
      const show = `the resolved${out.defaulted?.length ? ', defaulted' : ''} and derived values, every warning and the full terms`;
      return [
        `Show the user ${show}.`,
        ...(out.inferred?.length ? ['Confirm every inferred value with the user (their wording was matched to an option by a model).'] : []),
        ...(codes(out.warnings).has('possible_duplicate') ? ['Add --allow-duplicate only if the user saw the matching requests and explicitly wants another one.'] : []),
        `Only after they explicitly accept these terms: node mcaps-subscription.mjs submit --plan ${out.planId} --accept-terms <terms.sha>`,
      ].join(' ');
    }
    if (out.status === 'needs_input') {
      const m = out.missing ?? [];
      if (m.some((x) => x.code === 'field_absent')) return 'A field is gone from the portal form: tell the user the skill needs an update, and stop.';
      const parts = [];
      if (m.some((x) => !x.code)) parts.push('Ask the user for each missing value, offering its options.');
      for (const x of m.filter((y) => y.code === 'unknown_required_field')) parts.push(`The portal added the required field "${x.label ?? x.id}": only with the user's approved value, add --field ${x.id}=<value>.`);
      for (const x of m.filter((y) => y.code === 'field_drift')) parts.push(`The ${x.field} control changed: show its suggested control and candidates and add --map ${x.field}=<id> only for the control the user picks.`);
      return [...parts, 'Then re-run plan with the same flags plus the answers. Never pick a value yourself.'].join(' ');
    }
    if (out.status === 'invalid') {
      const e = out.errors ?? [];
      if (e.some((x) => x.code === 'unsupported_field')) return 'A form control cannot be set by this skill: tell the user the skill needs an update, and stop.';
      if (e.length && e.every((x) => x.code === 'set_failed' || x.code === 'owner_not_bound')) return 'Re-run plan once with the same flags. If it fails again, report it and stop.';
      return 'Show each errors entry with its candidates or message and ask the user; re-run plan with their corrected values. Never pick a candidate or a person yourself.';
    }
    if (out.status === 'blocked') return "Report each blocker's message to the user and stop. Do not work around it.";
    return undefined;
  }
  if (cmd === 'submit') {
    if (out.outcome === 'success') return `Report case ${out.caseId} and its status to the user.`;
    if (out.outcome === 'rejected') return "Nothing was created. Show the portal's errors verbatim, fix the values with the user, then re-run plan.";
    if (out.outcome === 'unknown') return `Do NOT resubmit. Tell the user the request may exist; ${out.probableCaseId ? `run status --case ${out.probableCaseId} (found: true confirms it)` : 'run status in a few minutes'} and report what it shows.`;
    if (out.outcome === 'not_submitted') {
      const r = out.reason;
      if (['plan_no_longer_ready', 'plan_mismatch', 'form_changed', 'submit_body_mismatch'].includes(r)) return `Nothing was sent. ${REPLAN}`;
      if (r === 'duplicate_active') return 'Nothing was sent. Show the matching requests; only if the user explicitly asks for another request, show the terms again, get acceptance and run the same submit with --allow-duplicate.';
      if (r === 'validation_failed' || r === 'submit_contract_changed') return 'Nothing was sent. Report it to the user and stop; the skill may need an update.';
      return `Nothing was sent. Report the message.${r === 'not_delivered' ? ' Check the network or VPN.' : ''} ${RETRY_SUBMIT}`;
    }
    return undefined;
  }
  if (cmd === 'status' && out.found === false) return 'The case is not visible yet: tell the user and check again later. Never resubmit because of it.';
  return undefined;
}

const EXIT = { ready: 0, success: 0, ok: 0, needs_input: 2, invalid: 2, blocked: 2, not_submitted: 2, rejected: 2, unknown: 3, error: 1 };
const PLAN_TTL_MS = 30 * 60 * 1000;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      title: { type: 'string' }, purpose: { type: 'string' }, type: { type: 'string' }, owner: { type: 'string' },
      allowance: { type: 'string' }, timezone: { type: 'string' }, 'tenant-type': { type: 'string' }, 'tenant-licensing': { type: 'string' },
      'tenant-name': { type: 'string' }, field: { type: 'string', multiple: true }, map: { type: 'string', multiple: true }, json: { type: 'string' },
      plan: { type: 'string' }, 'accept-terms': { type: 'string' }, 'allow-duplicate': { type: 'boolean' },
      case: { type: 'string' }, headed: { type: 'boolean' }, ephemeral: { type: 'boolean' }, browser: { type: 'string' }, verbose: { type: 'boolean' }, pretty: { type: 'boolean' },
      'full-terms': { type: 'boolean' }, 'no-defaults': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  return { cmd: positionals[0], extra: positionals.slice(1), v: values };
}

function readInput(v, stdinText) {
  let raw = {};
  if (v.json) raw = JSON.parse(v.json === '-' ? stdinText() : readFileSync(v.json, 'utf8'));
  const flags = { title: v.title, purpose: v.purpose, type: v.type, owner: v.owner, allowance: v.allowance, timezone: v.timezone, tenantType: v['tenant-type'], tenantLicensing: v['tenant-licensing'], tenantName: v['tenant-name'] };
  for (const [k, val] of Object.entries(flags)) if (val !== undefined) raw[k] = val;
  if (v.field?.length) {
    raw.fields = { ...(raw.fields ?? {}) };
    for (const kv of v.field) {
      const i = kv.indexOf('=');
      if (i < 1) throw new SkillError('bad_args', `--field expects id=value, got "${kv}"`);
      raw.fields[kv.slice(0, i).trim()] = kv.slice(i + 1);
    }
  }
  if (v.map?.length) {
    raw.map = { ...(raw.map && typeof raw.map === 'object' ? raw.map : {}) };
    for (const kv of v.map) {
      const i = kv.indexOf('=');
      if (i < 1 || !kv.slice(i + 1).trim()) throw new SkillError('bad_args', `--map expects slot=fieldId, got "${kv}"`);
      raw.map[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }
  return normalizeInput(raw);
}

const profilePath = (dir) => join(dir, 'profile.json');
const readProfile = (dir) => { try { return JSON.parse(readFileSync(profilePath(dir), 'utf8')); } catch { return {}; } };
const saveProfile = (dir, p) => { try { writeFileSync(profilePath(dir), JSON.stringify({ ...readProfile(dir), ...p, updatedAt: new Date().toISOString() }, null, 2)); } catch {} };

function publicPlanView(r, { fullTerms }) {
  const { resolved, derived, defaulted, inferred, missing, errors, blockers, warnings, eligibility, validation, terms, status, timings } = r;
  return {
    status, resolved, defaulted, ...(inferred?.length ? { inferred } : {}), derived, missing, errors, blockers, warnings,
    eligibility: eligibility?.ok ? { activeRequests: eligibility.active } : eligibility,
    validation: validation && { ok: validation.ok, failures: validation.failures },
    terms: terms?.sha ? { sha: terms.sha, links: terms.links, text: fullTerms || status === 'ready' ? terms.text : `${terms.text.slice(0, 280)}…` } : terms,
    timings,
  };
}

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
  if (!['plan', 'submit', 'status', 'options'].includes(cmd)) return { code: 1, out: { ok: false, error: 'bad_args', message: `Unknown command ${cmd}`, usage: HELP } };
  const formUrl = env.MCAPS_PORTAL_URL || DEFAULT_FORM_URL;
  const dir = stateDir(env);
  const logFile = env.MCAPS_LOG_FILE;
  const log = (m) => {
    if (v.verbose) process.stderr.write(`[mcaps] ${m}\n`);
    if (logFile) try { appendFileSync(logFile, `${new Date().toISOString()} ${cmd} ${m}\n`); } catch {}
  };

  let input;
  let plan;
  try {
    if (cmd === 'plan' || cmd === 'options') input = readInput(v, stdinText);
    if (cmd === 'submit') {
      if (!v.plan || !v['accept-terms']) throw new SkillError('bad_args', 'submit requires --plan <planId> and --accept-terms <termsSha> from a ready plan.');
      try { plan = loadPlan(dir, v.plan); } catch (e) { throw new SkillError('plan_invalid', e.message); }
      if (plan.formUrl !== formUrl) throw new SkillError('plan_mismatch', 'Plan was created for a different portal URL.');
      if (v['accept-terms'] !== plan.terms.sha) throw new SkillError('terms_not_accepted', 'The --accept-terms value does not match the terms shown in the plan. Show the terms to the user and pass the exact sha they accepted.');
      const r = plan.material.resolved;
      const prior = readLock(dir, requestKey({ title: plan.input.title, owner: r.owner, type: r.type, purpose: r.purpose }));
      const reopenable = prior?.state === 'reconciled' && (prior.outcome === 'rejected' || (v['allow-duplicate'] && prior.outcome === 'success'));
      if (prior && !reopenable && prior.state !== 'prepared') {
        return { code: EXIT.error, out: { ok: false, error: 'already_submitted', message: `This request was already ${prior.state}${prior.caseId ? ` as ${prior.caseId}` : ''}. Refusing to submit again; run status.${prior.outcome === 'success' ? ' Pass --allow-duplicate only if the user explicitly wants a second, identical subscription.' : ''}`, previous: { state: prior.state, caseId: prior.caseId ?? null, outcome: prior.outcome ?? null, probableCaseId: prior.probableCaseId ?? null } } };
      }
    }
    if (cmd === 'status' && v.case && !/^REQ-\d{6}-\d{4}$/.test(v.case)) throw new SkillError('bad_args', 'Case ids look like REQ-123456-2026.');
  } catch (e) {
    return { code: 1, out: { ok: false, error: e.code ?? 'bad_args', message: e.message } };
  }

  const t0 = performance.now();
  let s;
  try {
    s = await openSession({ formUrl, headless: !v.headed, browserPath: v.browser, profileDir: v.ephemeral || env.MCAPS_EPHEMERAL === '1' ? undefined : (env.MCAPS_PROFILE_DIR || join(dir, 'profile')), traceNet: env.MCAPS_TRACE_NET === '1', log });
    if (cmd === 'status') {
      const res = await ownRequests(s, readProfile(dir).contactId, { caseId: v.case });
      saveProfile(dir, { contactId: res.contactId });
      if (v.case) return { code: res.requests.length ? 0 : 2, out: { ok: true, found: res.requests.length > 0, requests: res.requests, ms: Math.round(performance.now() - t0) } };
      return { code: 0, out: { ok: true, requests: res.requests, ms: Math.round(performance.now() - t0) } };
    }
    await openForm(s);
    if (cmd === 'plan' || cmd === 'options') {
      // System One assists plan only: submit and options never create or call it.
      let systemOne = null;
      let refused = null;
      if (cmd === 'plan') try { systemOne = createSystemOne(env); } catch (e) { refused = e.message; log(`systemone refused: ${e.message}`); }
      const r = await fill(s, input, { discover: cmd === 'options', defaults: !v['no-defaults'], timeZone: systemTimeZone(env), systemOne });
      if (refused) r.warnings.push({ code: 'systemone_refused', message: `System One is not used: ${refused}` });
      if (r.contactId) saveProfile(dir, { contactId: r.contactId });
      const effective = r.input ?? input;
      if (cmd === 'plan' && r.status === 'ready' && r.contactId) {
        const dup = await findDuplicates(s, r.contactId, effective.title);
        if (!dup.ok) r.warnings.push({ code: 'duplicate_check_failed', message: dup.error });
        else if (dup.rows.length) r.warnings.push({ code: 'possible_duplicate', message: 'You already have an active request with this title from the last 24h; submit will refuse unless --allow-duplicate is passed.', requests: dup.rows });
      }
      const view = publicPlanView(r, { fullTerms: v['full-terms'] });
      if (cmd === 'options') return { code: 0, out: { ok: true, status: r.status, fields: r.fields, defaulted: r.defaulted, missing: r.missing, errors: r.errors, blockers: r.blockers, warnings: r.warnings, ms: Math.round(performance.now() - t0) } };
      const out = { ok: r.status === 'ready', ...view, ms: Math.round(performance.now() - t0), phases: s.marks, profile: s.profile };
      if (r.status === 'ready') {
        const material = planMaterial(formUrl, effective, r);
        const id = hashPlan(material);
        const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString();
        savePlan(dir, { planId: id, createdAt: new Date().toISOString(), expiresAt, formUrl, input: effective, material, terms: { sha: r.terms.sha } });
        Object.assign(out, { planId: id, expiresAt });
      }
      return { code: EXIT[r.status] ?? 1, out };
    }
    const res = await submit(s, plan, { dir, allowDuplicate: !!v['allow-duplicate'] });
    return { code: EXIT[res.outcome] ?? 1, out: { ok: res.outcome === 'success', ...res, ms: Math.round(performance.now() - t0) } };
  } catch (e) {
    const code = e.code === 'ALREADY_SUBMITTED' ? 'already_submitted' : e.code ?? 'error';
    return { code: EXIT.error, out: { ok: false, error: code, message: e.message, ...(e.lock ? { previous: { state: e.lock.state, caseId: e.lock.caseId ?? null, outcome: e.lock.outcome ?? null } } : {}), ...(e.state ? { state: e.state } : {}), ...(e.portal ? { portal: e.portal } : {}), ...(e.url ? { url: e.url } : {}) } };
  } finally {
    await s?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // An interrupted run must not leave a signed-in browser behind (the pipe also makes it exit on its own).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.once(sig, () => { killAllBrowsers(); process.exit(130); }); } catch {}
  }
  const argv = process.argv.slice(2);
  const { code, out } = await run(argv);
  process.stdout.write(`${JSON.stringify(out, null, argv.includes('--pretty') ? 2 : 0)}\n`);
  process.exitCode = code;
}
