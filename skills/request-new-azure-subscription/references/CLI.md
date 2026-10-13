# `mcaps-subscription.mjs` reference

What the agent does with each result is in [SKILL.md](../SKILL.md). Form drift, validator proofs and System One are in [DRIFT.md](DRIFT.md). This file is the precise reference.

## Synopsis

```text
node scripts/mcaps-subscription.mjs plan    [inputs] [common]
node scripts/mcaps-subscription.mjs options [inputs] [common]
node scripts/mcaps-subscription.mjs submit  --plan <planId> --accept-terms <terms.sha> [--allow-duplicate] [common]
node scripts/mcaps-subscription.mjs status  [--case REQ-123456-2026] [common]
node scripts/mcaps-subscription.mjs --help
```

Every run prints exactly one JSON object on stdout (`--pretty` indents it). Diagnostics go to stderr only with `--verbose`.

| Command | Sends or changes a request? | Does |
|---|---|---|
| `plan` | No. Every portal write except sign-in traffic is blocked at the network layer. | Fills the live form, resolves every value, runs the portal's eligibility checks, reads the derived manager and the terms, and saves a plan for 30 minutes. |
| `options` | No (same blocking as `plan`). | Lists the visible fields and their current options for the given selections. Saves nothing. |
| `submit` | At most one form POST, carrying only the planned values. | Re-verifies the saved plan against the live form, accepts the terms, and posts once. Journaled so the same request is never sent twice. |
| `status` | No. | Reads your recent requests from the portal Web API. |

## Flags

### Inputs (`plan`, `options`)

All optional. A value not given is defaulted and listed in `defaulted`. A default is applied only when it maps to exactly one current option; otherwise the field is reported in `missing`. `submit` replays the planned values, defaults included, and never re-defaults.

| Flag | Default | Notes |
|---|---|---|
| `--title <text>` | `<owner alias> Azure subscription <YYYY-MM-DD>` | At most 256 characters. |
| `--purpose <text>` | The only option, if there is exactly one | Matched to the live list: exact value or label, then a unique substring or all-words match (case-insensitive). |
| `--type internal\|external` | `internal`; asked for instead when any `--tenant-*` value is given | Tenant values only apply to external. |
| `--owner <alias\|email\|full name>` | The signed-in user | Resolved through the portal's people search. Matched exactly (email, alias or full display name), never partially. |
| `--allowance <amount>` | The highest amount offered | Monthly allowance, matched by amount. |
| `--timezone <zone>` | `MCAPS_TIMEZONE`, else this computer's IANA zone | A portal label (`Pacific Time`), an IANA name (`America/Los_Angeles`) or an offset (`UTC-08:00`). |
| `--tenant-type`, `--tenant-licensing` | The only option, if there is exactly one | External subscriptions only. |
| `--tenant-name <text>` | None | External subscriptions only. At most 50 characters. |
| `--field <id>=<value>` | None | Repeatable. A value for a required field the portal added (`unknown_required_field`). Not for a named input's control (`use_named_input`). |
| `--map <slot>=<id>` | None | Repeatable. Binds a named input to a changed control after the user confirmed a `field_drift` entry. Slots: `title`, `purpose`, `type`, `allowance`, `timezone`, `tenantType`, `tenantLicensing`, `tenantName` (never `owner`). Part of the plan and replayed by `submit`. See [DRIFT.md](DRIFT.md). |
| `--json <file\|->` | None | The same inputs as one JSON object: `title`, `purpose`, `type`, `owner`, `allowance`, `timezone`, `tenantType`, `tenantLicensing`, `tenantName`, `fields`, `map`. Flags override it. |
| `--no-defaults` | Off | Apply no defaults: every value not given is reported in `missing`. |
| `--full-terms` | Off | Include the full terms text even when the plan is not ready (a ready plan always has it). |

### `submit`

| Flag | Notes |
|---|---|
| `--plan <planId>` | Required. The `planId` of a ready plan (valid until its `expiresAt`). |
| `--accept-terms <terms.sha>` | Required. The `terms.sha` of that plan, after the user accepted its terms. |
| `--allow-duplicate` | Allows a request whose title matches an active request of yours from the last 24 h, or one that already succeeded. Only when the user explicitly asks. |

### `status`

| Flag | Notes |
|---|---|
| `--case REQ-123456-2026` | Ask the server for this request only. Without it, `status` lists your 10 most recent requests. |

### Common

| Flag | Effect |
|---|---|
| `--headed` | Show the browser so the user can finish sign-in (when silent SSO fails). |
| `--ephemeral` | Use a throwaway browser profile for this run. |
| `--browser <path>` | Chromium-family browser executable (default: Edge, then Chrome). |
| `--verbose` | Diagnostics on stderr. |
| `--pretty` | Indented JSON. |
| `-h`, `--help` | Print the usage text as `{ "usage": "..." }`. |

## Output

### Every command

| Field | Meaning |
|---|---|
| `ok` | `true` when the command achieved its goal (a ready plan, a successful submit, a found case). |
| `error`, `message` | On errors (`ok: false`, exit 1): the code (see [Errors](#errors)) and a human message. Some errors add `previous`, `portal`, `state` or `url`. |
| `next` | On every result that needs a follow-up (plans, `submit` outcomes, errors, `status --case` not found): the next step, consistent with [SKILL.md](../SKILL.md). A ready plan's `next` never contains the terms sha. |
| `ms` | Wall time of the run. |

### `plan`

| Field | Meaning |
|---|---|
| `status` | `ready`, `needs_input` (see `missing`), `invalid` (see `errors`) or `blocked` (see `blockers`). |
| `resolved` | Each field's match: choice fields `{ value, label }`, text fields `{ value }`, owner `{ display, upn, matchedBy }`. An option matched by System One also has `matchedBy: systemone` and `confidence`. |
| `defaulted` | `[{ field, value, reason }]`: values the user did not give. |
| `inferred` | Only with System One: `[{ field, wanted, value, label, confidence }]`, the user's own wording matched to one option. Must be confirmed with the user. |
| `derived` | Values the portal fills in: `ownerGuid`, `ownerUpn`, `ownerDisplay`, `manager`, `managerEmail`. |
| `missing`, `errors`, `blockers`, `warnings` | Entries with a `code` (except plain `missing` entries); see [Codes](#codes). |
| `eligibility` | `{ activeRequests }` from the portal's own active-request check. |
| `validation` | `{ ok, failures }` from the portal's client-side validators (ready plans only). |
| `terms` | `{ sha, text, links }`. `text` is truncated unless the plan is ready or `--full-terms` is set. |
| `planId`, `expiresAt` | Ready plans only. |
| `timings`, `phases`, `profile` | Performance data; `profile` is `persistent` or `throwaway`. |

### `options`

`{ ok, status, fields: [{ id, label, required, value, options? }], defaulted, missing, errors, blockers, warnings }`. Exit 0 whatever the `status`.

### `submit`

| Field | Meaning |
|---|---|
| `outcome` | `success`, `rejected`, `not_submitted` or `unknown` (see [Submit outcomes](#submit-outcomes)). |
| `caseId`, `status`, `createdOn` | `success` only: the new request as the Web API shows it. |
| `errors`, `modals` | `rejected` only: the portal's field errors `[{ field, message }]` and dialogs. |
| `reason`, `message` | `not_submitted`: why nothing was sent, plus details (`changes`, `fields`, `failures`, `requests`, `missing`, `errors`, `blockers`). |
| `probableCaseId`, `candidates` | `unknown` only, when seen: a case id shown only on the response page, or several matching requests. |
| `requestKey`, `timings` | Journal key and performance data. |

### `status`

`{ ok, requests: [{ caseId, name, status, active, createdOn, id }] }`. With `--case`, also `found` (`false` means exit 2).

## Codes

### Plan `missing` entries

| `code` | Meaning | Remedy |
|---|---|---|
| (none) | A value is needed: `{ field, id, label, options? }`. | Ask the user; re-plan with it. |
| `unknown_required_field` | The portal added a required field: `{ field: "fields.<id>", id, label, options? }`. | `--field <id>=<value>` with the user's value. |
| `field_drift` | A named input's control changed and could not be proven: `{ field, expectedId, label?, suggested?, candidates }` (with System One: `rankedBy`, `candidates[].p`, `pNone`, `truncated?`). | `--map <field>=<id>` only after the user confirms. [DRIFT.md](DRIFT.md). |
| `field_absent` | The control is gone and nothing eligible remains: `{ field, expectedId }`. | The skill needs an update. |

### Plan `errors` entries

| `code` | Meaning | Remedy |
|---|---|---|
| `invalid_option` | No option matches `wanted`; `candidates` lists options. | Pick one of `candidates`. |
| `ambiguous_option` | Several options match `wanted`. | Pick one of `candidates`. |
| `owner_not_found` | No directory match for the owner. | Exact alias or email. |
| `ambiguous_owner` | Several people match; `candidates` lists them. | Exact alias or email. |
| `invalid_owner` | The owner search needs at least 3 characters. | Exact alias or email. |
| `owner_not_bound` | The portal did not accept the chosen owner. | Re-plan. |
| `field_unavailable` | A value was given for a field the form does not show for these selections. | Drop it or change selections. |
| `too_long` | Longer than `max` characters. | Shorten. |
| `use_named_input` | `--field` targets a named input's control. | Use the named flag. |
| `invalid_mapping` | A `--map` target fails the live checks (`reason`: hidden, wrong kind, option shape, …). | Another confirmed control, or drop `--map`. |
| `portal_validation` | A portal validator failed (`message`). | Correct the value. |
| `set_failed` | The form did not keep the value (`detail`). | Re-plan. |
| `unsupported_field` | The control is of a type the driver cannot set. | The skill needs an update. |

### Plan `blockers`

| `code` | Meaning |
|---|---|
| `active_request` | The owner already has an active request of this type (`requests` when known). |
| `limit_reached` | The portal reports a request limit. |
| `portal_alert` | Another portal dialog stopped the request (`title`, `message`). |
| `mcaps_access` | The signed-in user failed the portal's MCAPS access check. |
| `eligibility_unverified` | The owner's active requests could not be checked. |
| `owner_cleared` | The portal cleared the owner after its eligibility checks. |
| `manager_missing` | No reporting manager was populated for the owner. |
| `terms_unavailable` | The terms could not be read. |
| `form_drift` | The owner control changed (never auto-healed), a bound control no longer posts the value that was set (`reason`: `unbound`, `value_changed`), or the form has a file upload (`file_input`). |

A blocker can't be fixed by changing flags; report it.

### Plan `warnings`

| `code` | Meaning |
|---|---|
| `field_remapped` | A named input was bound to a different control than expected: `{ field, expectedId, id, label, via }`. `via` is `renamed` (same label, new id), `mapped` (the user's `--map`) or `validator` (proven by the portal's own required-field validator; `evidence.message`). |
| `possible_duplicate` | You have an active request with this title from the last 24 h (`requests`). `submit` refuses it unless `--allow-duplicate`. |
| `duplicate_check_failed` | The duplicate check failed; `submit` checks again. |
| `portal_note` | An informational portal dialog (`title`, `message`). |
| `portal_check_pending` | A portal access check had not finished; `submit` checks again. |
| `input_ignored` | A value does not apply to the selected type (for example tenant fields on internal). |
| `systemone_refused` | `MCAPS_SYSTEMONE_URL` is not an allowed endpoint, so the plan ran without System One. |

### Submit outcomes

| `outcome` | Exit | Meaning |
|---|---|---|
| `success` | 0 | Exactly one new request with this title appeared in your requests after the POST. |
| `rejected` | 2 | The POST returned 200, the portal re-rendered the form with `errors`, and the Web API shows no new request. Nothing was created; a corrected plan may be submitted. |
| `not_submitted` | 2 | Nothing reached the portal (see `reason`). The same plan may be submitted again. |
| `unknown` | 3 | The POST was sent but exactly one new request could not be proven. Never resubmit; the journal refuses it anyway. |

A request was created only when `outcome` is `success` and `caseId` is present, or `status` shows it.

### `not_submitted` reasons

| `reason` | Meaning |
|---|---|
| `plan_no_longer_ready` | Re-verification found `missing`, `errors` or `blockers`. |
| `plan_mismatch` | The form, the bound controls (`fieldMap`), the posted field names (`postNames`), a validator proof or a resolved value changed since planning (`changes`). |
| `form_changed` | A verified value changed before the click, a bound control no longer posts exactly once under its planned name, or a file upload appeared (`fields`). |
| `submit_body_mismatch` | The browser tried to post other values or fields than those verified; the POST was blocked (`fields`, names only). |
| `duplicate_active` | You have an active request with this title from the last 24 h (`requests`). |
| `duplicate_check_failed` | The duplicate check failed. |
| `terms_ui_failed` | The terms checkbox could not be set. |
| `validation_failed` | The portal's client-side validation failed (`failures`). |
| `submit_contract_changed` | The submit button no longer posts back the way the driver expects. |
| `no_post` | The portal's scripts never sent the request (`modals`, `validation`). |
| `not_delivered` | The connection failed before the request reached the portal. |
| `error` | The driver failed before anything was sent. |

### Errors

`ok: false`, exit 1, from any command unless noted.

| `error` | Meaning | Remedy |
|---|---|---|
| `bad_args` | Unknown command, invalid flag or malformed value. | Fix the command. |
| `invalid_mapping` | A `--map` entry is malformed, names an unknown slot or `owner`, targets a portal-populated field, maps two slots to one control, or takes another slot's control. Checked before the browser starts. | Fix or drop the `--map`. |
| `auth_required` | Silent SSO did not finish. | Re-run with `--headed`; the user signs in. |
| `vpn_required` | The portal's corporate-network check failed. | Connect to the corporate network or VPN. |
| `portal_unreachable` | The portal did not answer (timeout, DNS, refused, proxy). Nothing was submitted. | Check the network or VPN; retry. |
| `non_microsoft_account` | The signed-in account is not a Microsoft corporate account. | Sign in with the corporate account. |
| `no_eligible_purpose` | The portal offers no purpose for the user's organization (`portal` has its dialogs). | None in the skill. |
| `plan_invalid` | `submit`: the plan is unknown, expired or was modified after `plan` wrote it. | Re-plan. |
| `plan_mismatch` | `submit`: the plan was made for another portal URL. | Re-plan. |
| `terms_not_accepted` | `submit`: `--accept-terms` does not match the plan's `terms.sha`. | Show the plan's terms; pass the sha the user accepted. |
| `already_submitted` | `submit`: this request key (title, owner, type, purpose) is already journaled as sent, in progress or unresolved (`previous`). Only a `rejected` request, or with `--allow-duplicate` a `success`, can be sent again. | Run `status`. |
| `guard_unavailable` | Write-blocking could not be enabled on a page; the run was aborted. | Retry. |
| `form_lost`, `navigation_failed`, `portal_timeout`, `browser_unresponsive`, `cdp_timeout`, `api_failed`, `contact_unknown` | Transient portal or browser problems. | Retry. `submit` sends nothing before its journal entry, so a retry is safe. |
| `error` | Anything else (for example no browser found). | Read `message`. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The command worked: a ready plan, `options` output, `submit` `success`, `status` output, `--help`. Not proof that a request exists. |
| `2` | Needs action or nothing was created: `needs_input`, `invalid`, `blocked`, `not_submitted`, `rejected`, `status --case` not found. |
| `3` | `submit` outcome `unknown`. |
| `1` | Error (`ok: false`), or no command given. |

## Environment

| Variable | Effect |
|---|---|
| `MCAPS_TIMEZONE` | Default time zone (IANA name such as `Europe/Dublin`, or a portal label) instead of this computer's. |
| `MCAPS_BROWSER` | Browser executable. |
| `MCAPS_EPHEMERAL=1` | Always use throwaway profiles. |
| `MCAPS_SKILL_HOME` | State directory. |
| `MCAPS_PROFILE_DIR` | Persistent profile location. |
| `MCAPS_LOG_FILE` | Append the diagnostic log to a file. |
| `MCAPS_TRACE_NET=1` | Log every network request with its duration. |
| `MCAPS_PORTAL_URL` | Another portal URL (tests use a local mock). |
| `MCAPS_SYSTEMONE_URL` | Optional System One endpoint for `plan` only. Unset (default) disables it. Loopback only unless the https host is in `MCAPS_SYSTEMONE_ALLOW_REMOTE`. See [DRIFT.md](DRIFT.md). |
| `MCAPS_SYSTEMONE_MODEL` | Model name (default `clm-latest`). |
| `MCAPS_SYSTEMONE_KEY`, `TYPESAFE_API_KEY` | API key, if the endpoint needs one. |
| `MCAPS_SYSTEMONE_ALLOW_REMOTE` | Comma-separated https hosts allowed besides loopback. |
| `MCAPS_SYSTEMONE_TIMEOUT_MS` | Per-question timeout (default 2000). A timeout or bad answer is ignored. |

Behind a TLS-inspecting proxy, set `NODE_EXTRA_CA_CERTS` to the corporate root CA. With Node 24+, `NODE_USE_ENV_PROXY=1` honors `HTTPS_PROXY`. The browser uses the system proxy settings.

## State

State lives in `%LOCALAPPDATA%\mcaps-subscription-skill`, `$XDG_STATE_HOME/mcaps-subscription-skill` or `~/.local/state/mcaps-subscription-skill` (override: `MCAPS_SKILL_HOME`). Files are owner-only (`0600`, directories `0700`). The agent never edits or deletes them.

| Path | Holds |
|---|---|
| `plans/` | Saved plans, integrity-checked, 30-minute lifetime. |
| `locks/` | The exactly-once submit journal. Never delete it. |
| `profile/` | The persistent browser profile: keeps the portal sign-in between runs in the browser's own OS-encrypted store (at most 8 hours). To sign out, the user deletes it. If it is busy, the run uses a throwaway profile. |
| `profile.json` | Cached portal contact id. |

The browser is driven over `--remote-debugging-pipe`, so no DevTools TCP port is opened. If the driver dies, the browser exits with it; Ctrl+C and SIGTERM also close it.
