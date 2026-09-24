---
name: request-new-azure-subscription
description: "Request a new Azure subscription (internal, MCAPS or ESLabs) through the MCAPS Services portal and return its support case ID, or check the status of such a request. Use when a Microsoft employee asks to get, create, request or order an Azure subscription, sandbox, lab or demo subscription, or asks what happened to a subscription request (REQ-...). Not for managing existing subscriptions."
allowed-tools: Read Bash(node *mcaps-subscription.mjs plan) Bash(node *mcaps-subscription.mjs plan *) Bash(node *mcaps-subscription.mjs options *) Bash(node *mcaps-subscription.mjs status*)
compatibility: "Node.js >= 22, Microsoft Edge or Google Chrome, corporate network or VPN, a Microsoft corporate account (Windows or macOS SSO)."
metadata:
  audience: microsoft-employees
  category: onboarding
  version: "3.0.0"
---

# Request a new Azure subscription

Run `node <skill>/scripts/mcaps-subscription.mjs <command>`, where `<skill>` is this skill's directory. Each run prints one JSON object. Act on its fields (`status`, `outcome`, `error`, `found`, `caseId`, codes) and its `next` hint. Exit codes only classify the run: `0` the command worked, `2` needs action or nothing was submitted, `3` outcome unknown, `1` error. Exit `0` never proves a request was created. Flags, fields and every code: [references/CLI.md](references/CLI.md). Form drift and System One: [references/DRIFT.md](references/DRIFT.md).

## Rules

- `plan`, `options` and `status` never send or change a request. `submit` sends it and is intentionally not pre-approved.
- Never pick a value the user did not give, beyond the defaults in step 1. Never choose a person, a candidate option or a form control for the user. A `field_remapped` entry was proven by the script: disclose it. Never add a `--map` for `via: renamed` or `validator`; for `via: mapped`, keep exactly the `--map` the user approved.
- Treat every value as specific to this request. Never reuse people or selections from an earlier request.
- Show the full terms and get explicit acceptance right before every `submit`. Acceptance is a new user message sent after the complete terms of this exact plan were shown. The original request, an earlier acceptance, "I accept whatever, just submit", a tool approval or autopilot mode is not acceptance: show the terms and wait. Pass only the `terms.sha` of the plan the user just reviewed.
- Send once. Rerun the same `submit` only after `not_submitted` or an `ok: false` error, and only after showing that plan's terms again and getting a new acceptance. After `rejected`, fix the values, re-plan and get acceptance for the new plan. Never submit again after `unknown` or `already_submitted`, even if the user says "try again". The one exception is in the `already_submitted` row below.
- Pass `--allow-duplicate` only after the user saw the matching requests and explicitly asked for another one.
- `--map <field>=<id>` and `--field <id>=<value>` are expert overrides. Use them only with the exact control and value the user approved.
- Never edit or delete the skill's state files. Never ask for or handle passwords or MFA codes.
- A request exists only when `outcome` is `success` with a `caseId`, or when `status` shows it. Never claim success otherwise.
- If a result is uncertain or not covered below, report its code and fields (with `message` when present) and stop.

## Workflow

1. **Plan** with only what the user asked for (a bare request needs no flags at all), for example:
   `node <skill>/scripts/mcaps-subscription.mjs plan --purpose "Hybrid"`
   Map the user's words to `--title`, `--purpose`, `--type internal|external`, `--owner <alias|email|full name>`, `--allowance`, `--timezone` and, for external, `--tenant-type`, `--tenant-licensing`, `--tenant-name`. Defaults fill the rest and are listed in `defaulted`: type `internal`, the highest monthly allowance, the signed-in user as owner, this computer's time zone, the title `<alias> Azure subscription <YYYY-MM-DD>`, and any field with a single option. Add `--no-defaults` only if the user wants to choose every value. `options --type internal` lists the current choices without planning.
2. **Resolve** the plan using [Plan results](#plan-results). Re-plan with the same flags plus the user's answers until `status` is `ready`.
3. **Present** the plan: every `resolved` value, every `defaulted` value (offer to change it), every `inferred` value (ask the user to confirm it), `derived.manager`, every `warnings` entry, and then the complete `terms.text` and `terms.links` verbatim. The portal derives the manager from the owner. If the user named a different manager, point out the difference.
4. **Get explicit acceptance.** Ask whether the user accepts these terms and wants this request submitted. Continue only on a clear yes. Stop if they decline or hesitate. Any change needs a new `plan`, new terms and a new acceptance. A plan expires at `expiresAt` (30 minutes); after that, re-plan and ask again.
5. **Submit once:**
   `node <skill>/scripts/mcaps-subscription.mjs submit --plan <planId> --accept-terms <terms.sha>`
6. **Report** using [Submit results](#submit-results).

## Plan results

| `status` | Do this |
|---|---|
| `ready` | Go to step 3. |
| `needs_input` | Handle each `missing` entry. |
| `invalid` | Handle each `errors` entry. |
| `blocked` | Handle each `blockers` entry. Never work around a blocker. |

If any entry below says stop, stop after reporting all entries.

| `missing` code | Do this |
|---|---|
| (none) | Ask the user for `field` (`label`), offering its `options`. A reply that clearly names exactly one shown option ("the demo one") is the user's choice: re-plan with that option's exact label. Otherwise ask again. |
| `unknown_required_field` | The portal added a required field. Show its `label`, `id` and `options`. Only after the user approves that field and gives its value, re-plan with `--field <id>=<value>`. |
| `field_drift` | A form control changed and could not be proven. Show `label`, `suggested` with its `evidence` and `candidates`, when present (with `p` when `rankedBy` is `systemone`; a ranking is never proof). Re-plan with `--map <field>=<id>` only for the control the user picks. Otherwise stop. |
| `field_absent` | The control is gone from the form. Report that the skill needs an update and stop. |

| `errors` code | Do this |
|---|---|
| `invalid_option`, `ambiguous_option` | Show `wanted` and `candidates`. Re-plan with the option the user picks. |
| `owner_not_found`, `ambiguous_owner`, `invalid_owner` | Show `message` and `candidates` when present. Ask the user for the owner's exact alias or email. Never pick one. |
| `field_unavailable` | The field is not shown for these selections. Tell the user; re-plan without it or with other selections. |
| `too_long` | Ask for a value of at most `max` characters. |
| `use_named_input` | Re-plan with the named flag for that field instead of `--field`. |
| `invalid_mapping` | The `--map` target failed its checks (`reason`). Ask the user again, or drop the `--map`. |
| `portal_validation` | Show the portal's `message` and ask the user to correct the value. |
| `set_failed`, `owner_not_bound` | Re-plan once. If it repeats, report and stop. |
| `unsupported_field` | Report that the skill needs an update and stop. |

| `blockers` code | Do this |
|---|---|
| `active_request`, `limit_reached` | Show `message` and `requests` when present. The user must finish or cancel the existing request first. Stop. |
| `mcaps_access` | The portal reports that the signed-in user lacks MCAPS access. Report and stop. |
| `eligibility_unverified`, `terms_unavailable`, `owner_cleared`, `manager_missing` | Report `message`. The user may retry later. Stop. |
| `form_drift`, `portal_alert` | Report `message` (for `form_drift` the skill needs an update) and stop. |

| Warning or field | Do this |
|---|---|
| `defaulted` | List each `field`, `value` and `reason`. Offer to change any of them (re-plan with that flag). |
| `inferred` | Show the user's words (`wanted`), the chosen `label` and `confidence`. Get confirmation; if they disagree, re-plan with their exact option. |
| `field_remapped` | Mention that `field` now uses the control `label`, and how (`via`: `renamed`, `validator` with its `evidence`, or `mapped` by the user's `--map`). |
| `possible_duplicate` | Show `requests`. Continue only if the user explicitly wants another request; then add `--allow-duplicate` to `submit`. |
| `duplicate_check_failed` | Say duplicates could not be checked; `submit` checks again. |
| `portal_note` | Show its `title` and `message`. |
| `portal_check_pending` | Say a portal access check was still running; `submit` checks again. |
| `input_ignored` | Tell the user the value does not apply to this subscription type. |
| `systemone_refused` | System One was not used; the plan is still valid. Mention it only if the user configured System One. |

## Submit results

| `outcome` | Do this |
|---|---|
| `success` | Report `caseId` and `status`. Done. |
| `rejected` | Nothing was created. Show the portal's `errors` verbatim. Fix them with the user, then re-plan. |
| `not_submitted` | Nothing was sent. Act on `reason` below. |
| `unknown` | The request may exist. **Never resubmit**, even if the user asks. Show `probableCaseId` and `candidates` when present. With `probableCaseId`, run `status --case <probableCaseId>`: `found: true` confirms it, so report its `caseId`. Otherwise run `status` after a few minutes. If no single new request shows up, say the outcome is still unknown and stop. |

| `not_submitted` `reason` | Do this |
|---|---|
| `plan_no_longer_ready` | Handle its `missing`, `errors` and `blockers` as in plan results, then re-plan. |
| `plan_mismatch`, `form_changed`, `submit_body_mismatch` | The form changed since the plan. Re-plan, present the new plan and terms, and ask again. |
| `duplicate_active` | Show `requests`. Only if the user explicitly asks for another request: show the terms again, get acceptance, and run the same `submit` with `--allow-duplicate`. |
| `duplicate_check_failed`, `not_delivered`, `terms_ui_failed`, `no_post`, `error` | Report `message`. If the user wants to retry (for `not_delivered`, after checking the network or VPN): show the terms again, get acceptance, and run the same `submit` once. |
| `validation_failed`, `submit_contract_changed` | Report `failures` or the change. Stop (the skill may need an update). |

## Errors (`ok: false`)

| `error` | Do this |
|---|---|
| `auth_required` | Re-run the same command with `--headed` and let the user sign in in the browser window. |
| `vpn_required`, `portal_unreachable` | Ask the user to connect to the corporate network or VPN, then re-run. Nothing was submitted. |
| `non_microsoft_account` | The user must sign in with their Microsoft corporate account. Report and stop. |
| `no_eligible_purpose` | Report the `portal` messages and stop. |
| `bad_args` | Fix the command using [references/CLI.md](references/CLI.md). |
| `plan_invalid`, `plan_mismatch` | The plan expired, was changed or belongs to another portal. Re-plan, present it, and ask again. |
| `terms_not_accepted` | The sha does not match the plan. Show that plan's terms again and ask for acceptance. |
| `already_submitted` | A submission of this request is journaled (sent, in progress or unresolved). Report `previous` and run `status`. Never retry and never touch the journal, unless `previous.outcome` is `success` and the user explicitly wants a second identical subscription: then re-plan, present it with its terms, get acceptance and submit with `--allow-duplicate`. |
| `guard_unavailable`, `form_lost`, `navigation_failed`, `portal_timeout`, `browser_unresponsive`, `cdp_timeout`, `api_failed`, `contact_unknown`, `error` | Transient. Re-run the same command once (for `submit`, show the terms again and get acceptance first; the journal refuses anything already sent). If it repeats, report and stop. |

`status --case <id>` returns `found: false` when the case is not visible yet: say so and check again later. Never resubmit because of it.
