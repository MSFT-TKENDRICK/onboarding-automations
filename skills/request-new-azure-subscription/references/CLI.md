# `mcaps-subscription.mjs` reference

```text
node scripts/mcaps-subscription.mjs <plan|options|submit|status> [flags]
```

Every run prints one JSON object on stdout. With `--verbose`, diagnostics go to stderr; `--pretty` indents the JSON.

## Commands

| Command | Writes to the portal? | Purpose |
|---|---|---|
| `options` | No | Visible fields and current option lists for the given selections (`--type`, `--purpose`, …). |
| `plan` | No: every portal write is blocked at the network layer | Fill the live form, resolve every value, run the portal's eligibility checks, derive the manager, read the terms, save a plan (30 min TTL). |
| `submit` | Exactly one POST | Re-verify the saved plan against the live form and submit it. Requires `--plan` and `--accept-terms`. |
| `status` | No | Your recent requests from the portal Web API, or one with `--case REQ-123456-2026`. |

## Inputs (`plan`, `options`)

Every input is optional. Values not given are defaulted and listed in `defaulted`; `--no-defaults` turns defaults off so every value missing from the input is reported in `missing`. A default is applied only when it maps to exactly one current option; otherwise the field is reported in `missing`. `submit` replays the planned values (defaults included) exactly and never re-defaults.

| Flag | Default | Notes |
|---|---|---|
| `--title` | `<owner alias> Azure subscription <YYYY-MM-DD>` | Up to 256 characters. |
| `--purpose` | The only option, if exactly one | Matched to the current purpose list: exact value or label first, then a unique substring or all-words match (case-insensitive). Ambiguous → `invalid` with candidates. |
| `--type` | `internal` | `internal` or `external`. |
| `--owner` | The signed-in user | Alias, email or full name. Resolved through the portal's own people search. Ambiguous or unknown → candidates. |
| `--allowance` | The highest amount offered | Monthly allowance, matched to the current list. |
| `--timezone` | `MCAPS_TIMEZONE`, else this computer's IANA zone | `Pacific Time`, `America/Los_Angeles`, `UTC-08:00`, … |
| `--tenant-type`, `--tenant-licensing` | The only option, if exactly one | External subscriptions only. |
| `--tenant-name` | None | External subscriptions only. |
| `--field <id>=<value>` | None | Repeatable. For new required fields the portal adds (form drift). |
| `--json <file\|->` | | The same inputs as JSON (`title`, `purpose`, `type`, `owner`, `allowance`, `timezone`, `tenantType`, `tenantLicensing`, `tenantName`, `fields`). |
| `--no-defaults` | | Apply no defaults. |

## Common flags

| Flag | Effect |
|---|---|
| `--headed` | Visible browser for interactive sign-in (when silent SSO fails). |
| `--ephemeral` | Use a throwaway browser profile for this run (no reuse of the sign-in). |
| `--browser <path>` | Chromium-family browser to use (default: Edge, then Chrome). |
| `--full-terms` | Include the full terms text even when the plan is not ready. |
| `--allow-duplicate` | `submit` only. Allows a request whose title matches an active request from the last 24 h. Use only when the user explicitly asks. |

## `plan` output

| Field | Meaning |
|---|---|
| `status` | `ready`, `needs_input`, `invalid` or `blocked`. |
| `resolved` | Each field's matched `{ label, value }`. |
| `defaulted` | `[{ field, value, reason }]`: values the user did not give. Show them so the user can override. |
| `derived` | Values the portal derives, for example `manager`. |
| `missing` / `errors` | `{ field, message, options?, candidates? }`: ask the user. |
| `blockers` | Codes include `active_request`, `mcaps_access`, `owner_cleared`, `owner_not_found`, `manager_missing`, `unknown_required_field`, `portal_validation`. |
| `warnings` | Codes include `possible_duplicate`, `portal_note`, `portal_check_pending`, `input_ignored`. |
| `terms` | `{ sha, text, links }`. Show `text` to the user; pass `sha` to `submit` only after they accept. |
| `planId`, `expiresAt`, `next` | Present when `ready`. |
| `ms`, `phases`, `timings`, `profile` | Performance data; `profile` is `persistent` or `throwaway`. |

## `submit` outcomes

| `outcome` | Exit | Meaning | Next step |
|---|---|---|---|
| `success` | 0 | Exactly one new request with this title appeared in your requests (portal Web API) after the POST. `caseId`, `status`, `createdOn`. | Report `caseId`. |
| `rejected` | 2 | The portal re-rendered the form with validation `errors` (`[{ field, message }]`), the POST returned 200 and the Web API shows no new request. Nothing was created. | Fix with the user, re-plan. |
| `not_submitted` | 2 | Nothing was sent (see `reason` below). | Explain; re-plan if needed. |
| `unknown` | 3 | The POST was sent but no single new request could be proven. May include `probableCaseId` (seen only on the response page) or `candidates` (several matching requests). | **Never resubmit.** `status --case <probableCaseId>`, or `status` later. |

Exit code 0 only means the command worked. A request was created only when `outcome` is `success` **and** `caseId` is present.

`not_submitted` reasons:

| `reason` | Meaning |
|---|---|
| `plan_no_longer_ready` | Re-verification found missing, invalid or blocked values (`missing`, `errors`, `blockers`). |
| `plan_mismatch` | The form options or resolved values changed since planning (`changes`). |
| `duplicate_check_failed`, `duplicate_active` | The duplicate check failed, or an active request with this title exists (last 24 h). |
| `terms_ui_failed` | The terms checkbox could not be set. |
| `validation_failed` | The portal's client-side validation failed (`failures`). |
| `submit_contract_changed` | The submit button no longer posts back the way the driver expects. |
| `form_changed` | A verified value changed before submit (`fields`). |
| `submit_body_mismatch` | The browser tried to POST values other than the verified ones (`fields`, names only); it was blocked. |
| `no_post` | The portal's scripts never sent the request. |
| `not_delivered` | The request never reached the portal (connection failure before the request was sent). |
| `error` | The driver failed before anything was sent. |

After any `not_submitted`, a new `submit` of the same plan is allowed.

`submit` refuses (`error: already_submitted`, with `previous`) any request key (title + owner + type + purpose) that was already sent. The exceptions are a request conclusively `rejected` by the server, and, with `--allow-duplicate`, a request that already succeeded (the user explicitly wants a second identical subscription). A request whose outcome was `unknown` is never resubmitted.

## `status`

`status` lists your 10 most recent requests for this service. `status --case REQ-123456-2026` asks the server for that request only: `found: true` with `requests[0]`, or `found: false` with exit 2.

## Errors (`ok: false`, exit 1)

| `error` | Meaning |
|---|---|
| `bad_args` | Invalid flags. |
| `auth_required` | Silent SSO did not finish. Rerun with `--headed`; the user signs in themselves. |
| `vpn_required` | The portal's corporate-network check failed. Connect to VPN. |
| `portal_unreachable` | The portal did not answer (timeout, DNS, refused, proxy). Check the network/VPN and retry; nothing was submitted. |
| `non_microsoft_account` | The signed-in account is not a Microsoft corporate account. |
| `no_eligible_purpose` | The portal offers no purpose for the user's org; `portal` has its message. |
| `terms_not_accepted` | `--accept-terms` did not match the plan's `terms.sha`. |
| `already_submitted` | See above. |
| `plan_mismatch` | The plan was made for another portal URL. |
| `plan_invalid` | The saved plan is missing, expired, or was modified after `plan` wrote it. Re-run `plan`. |
| `guard_unavailable` | Write-blocking could not be enabled on a page; the run was aborted. |
| `form_lost`, `navigation_failed`, `portal_timeout`, `browser_unresponsive`, `api_failed`, `contact_unknown` | Transient portal or browser problems. Retrying `plan`/`status` is safe. |

## State and environment

State (plans, submission journal, browser profile) lives in `%LOCALAPPDATA%\mcaps-subscription-skill`, `$XDG_STATE_HOME/mcaps-subscription-skill` or `~/.local/state/mcaps-subscription-skill`.

The **persistent browser profile** (`<state>/profile`) keeps the portal sign-in between runs, which skips the SSO round trips. Its cookies stay in the browser's own OS-encrypted store and expire after at most 8 hours. To sign out, delete `<state>/profile`. If the profile is busy (for example a previous browser is still exiting), the run silently uses a throwaway profile. Never delete `<state>/locks`: it is the exactly-once journal. State files are created owner-only (`0600`, directories `0700`).

The browser is controlled over `--remote-debugging-pipe`, so no DevTools TCP port is opened. If the driver dies, the browser exits with it, and Ctrl+C/SIGTERM also close it.

| Variable | Effect |
|---|---|
| `MCAPS_SKILL_HOME` | Override the state directory. |
| `MCAPS_EPHEMERAL=1` | Always use throwaway profiles. |
| `MCAPS_PROFILE_DIR` | Override the persistent profile location. |
| `MCAPS_BROWSER` | Browser executable. |
| `MCAPS_TIMEZONE` | Default time zone (IANA name such as `Europe/Dublin`, or a portal label) instead of this computer's. |
| `MCAPS_LOG_FILE` | Append the diagnostic log to a file. |
| `MCAPS_TRACE_NET=1` | Log every network request with its duration (performance work). |
| `MCAPS_PORTAL_URL` | Point at another portal URL (tests use a local mock). |

Behind a TLS-inspecting proxy, set `NODE_EXTRA_CA_CERTS` to the corporate root CA. With Node 24+, set `NODE_USE_ENV_PROXY=1` to honor `HTTPS_PROXY`. The browser uses the system proxy settings.
