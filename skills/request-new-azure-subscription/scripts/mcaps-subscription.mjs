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
import { killAllBrowsers } from './lib/browser.mjs';

const HELP = `Usage: node mcaps-subscription.mjs <plan|submit|status|options> [flags]
Inputs (plan/options): --title --purpose --type internal|external --owner <alias|email|full name>
  --allowance 500 --timezone "Pacific Time" | America/Los_Angeles | UTC-08:00
  --tenant-type --tenant-licensing --tenant-name  --field <id>=<value> (repeatable)  --json <file|->
Submit: --plan <planId> --accept-terms <termsSha> [--allow-duplicate]
Status: [--case REQ-123456-2026]
Common: --headed (interactive sign-in)  --ephemeral (throwaway browser profile)  --browser <path>  --verbose  --pretty`;

const EXIT = { ready: 0, success: 0, ok: 0, needs_input: 2, invalid: 2, blocked: 2, not_submitted: 2, rejected: 2, unknown: 3, error: 1 };
const PLAN_TTL_MS = 30 * 60 * 1000;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      title: { type: 'string' }, purpose: { type: 'string' }, type: { type: 'string' }, owner: { type: 'string' },
      allowance: { type: 'string' }, timezone: { type: 'string' }, 'tenant-type': { type: 'string' }, 'tenant-licensing': { type: 'string' },
      'tenant-name': { type: 'string' }, field: { type: 'string', multiple: true }, json: { type: 'string' },
      plan: { type: 'string' }, 'accept-terms': { type: 'string' }, 'allow-duplicate': { type: 'boolean' },
      case: { type: 'string' }, headed: { type: 'boolean' }, ephemeral: { type: 'boolean' }, browser: { type: 'string' }, verbose: { type: 'boolean' }, pretty: { type: 'boolean' },
      'full-terms': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
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
  return normalizeInput(raw);
}

const profilePath = (dir) => join(dir, 'profile.json');
const readProfile = (dir) => { try { return JSON.parse(readFileSync(profilePath(dir), 'utf8')); } catch { return {}; } };
const saveProfile = (dir, p) => { try { writeFileSync(profilePath(dir), JSON.stringify({ ...readProfile(dir), ...p, updatedAt: new Date().toISOString() }, null, 2)); } catch {} };

function publicPlanView(r, { fullTerms }) {
  const { resolved, derived, missing, errors, blockers, warnings, eligibility, validation, terms, status, timings } = r;
  return {
    status, resolved, derived, missing, errors, blockers, warnings,
    eligibility: eligibility?.ok ? { activeRequests: eligibility.active } : eligibility,
    validation: validation && { ok: validation.ok, failures: validation.failures },
    terms: terms?.sha ? { sha: terms.sha, links: terms.links, text: fullTerms || status === 'ready' ? terms.text : `${terms.text.slice(0, 280)}…` } : terms,
    timings,
  };
}

export async function run(argv, { env = process.env, stdinText = () => readFileSync(0, 'utf8') } = {}) {
  let parsed;
  try { parsed = parse(argv); } catch (e) { return { code: 1, out: { ok: false, error: 'bad_args', message: e.message, usage: HELP } }; }
  const { cmd, v } = parsed;
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
      const r = await fill(s, input, { discover: cmd === 'options' });
      if (r.contactId) saveProfile(dir, { contactId: r.contactId });
      if (cmd === 'plan' && r.status === 'ready' && r.contactId) {
        const dup = await findDuplicates(s, r.contactId, input.title);
        if (!dup.ok) r.warnings.push({ code: 'duplicate_check_failed', message: dup.error });
        else if (dup.rows.length) r.warnings.push({ code: 'possible_duplicate', message: 'You already have an active request with this title from the last 24h; submit will refuse unless --allow-duplicate is passed.', requests: dup.rows });
      }
      const view = publicPlanView(r, { fullTerms: v['full-terms'] });
      if (cmd === 'options') return { code: 0, out: { ok: true, status: r.status, fields: r.fields, missing: r.missing, errors: r.errors, blockers: r.blockers, warnings: r.warnings, ms: Math.round(performance.now() - t0) } };
      const out = { ok: r.status === 'ready', ...view, ms: Math.round(performance.now() - t0), phases: s.marks, profile: s.profile };
      if (r.status === 'ready') {
        const material = planMaterial(formUrl, input, r);
        const id = hashPlan(material);
        const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString();
        savePlan(dir, { planId: id, createdAt: new Date().toISOString(), expiresAt, formUrl, input, material, terms: { sha: r.terms.sha } });
        Object.assign(out, { planId: id, expiresAt, next: `Show the user the plan and the full terms. Only after they explicitly accept: node mcaps-subscription.mjs submit --plan ${id} --accept-terms <terms.sha>` });
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
