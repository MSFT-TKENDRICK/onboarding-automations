# CLI reference

`node <skill>/scripts/startright-repo.mjs <command> [flags]` prints one JSON object on stdout (`--pretty` indents it; `--verbose` writes diagnostics to stderr). `node ... --help` prints the same usage as below.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The command worked. Never proves a repository exists. |
| `2` | Needs action, or nothing was created (`status` of `needs_input`, `invalid`, `blocked`; outcome `rejected` or `not_submitted`). |
| `3` | Outcome unknown or partial (`unknown`, `partial`). Never resubmit. |
| `1` | Error (`ok: false`): bad arguments, authentication, network, contract violation. |

## Commands

| Command | Purpose | Changes anything? |
|---|---|---|
| `plan` | Validate and resolve the request against live StartRight data, show the terms, save a plan for 30 minutes. | No |
| `options` | List organizations, search Service Tree (`--find-service`) or people/groups (`--org` + `--find-principal`, optional `--purpose acl\|ownership`). | No |
| `status` | `--repo <org>/<name>`: is it visible, is the name taken, what does the local journal say. Without `--repo`: recent repositories plus the journal. | No |
| `verify` | Maintainers: replays every read-only endpoint against `contract.mjs` and proves no write was sent. | No |
| `submit` | `--plan <planId> --accept-terms <terms.sha>`: re-verifies the plan against live data and creates the repository exactly once. | **Yes** |

## Plan inputs

| Flag | Notes |
|---|---|
| `--org` | Owner organization you belong to. |
| `--name` | Letters, digits, `.`, `_`, `-`; at most 100; not `.` or `..`. |
| `--description` | Required, at most 350 characters. |
| `--visibility` | `internal` (default) or `private`. |
| `--classification` | **Required, no default.** Only `non-production` is accepted. `production`, `tcb`, `hvt` return `blocked`. |
| `--service-tree <guid>` / `--service-tree-name <name>` | Service Tree ownership. The name must match exactly; ambiguity returns `candidates`. |
| `--direct-owner <person>` | The other owner (you are the second). Person = e-mail, alias or exact display name. |
| `--access "<person-or-group>=<role>"` | Repeatable. Roles: `read`, `triage`, `write`, `maintain`. You are added with `maintain`. At least one group, or two people, must hold `maintain`. |
| `--json <file\|->` | The same inputs as one JSON object; flags override it. |

Common flags: `--headed` (visible browser for sign-in), `--ephemeral`, `--browser <path>`, `--verbose`, `--pretty`.

## Environment

| Variable | Effect |
|---|---|
| `STARTRIGHT_URL` | Service base URL (tests point it at the loopback mock). Plans record it; a plan for another URL is `plan_mismatch`. |
| `STARTRIGHT_SKILL_HOME` | Directory for the browser profile, plans and the submission journal. |
| `STARTRIGHT_BROWSER` | Chromium-family browser path (default: Edge, then Chrome). |
| `STARTRIGHT_PROFILE_DIR` | Override the profile directory. |
| `STARTRIGHT_EPHEMERAL` | `1` = throwaway profile. |
| `STARTRIGHT_LOG_FILE` | Append diagnostics here. |
| `STARTRIGHT_AUTH_TIMEOUT_MS` | Sign-in wait (default 45 s headless, 5 min headed). |

## Plan output

`status`: `ready | needs_input | invalid | blocked`. Fields: `missing[]` (`field`, `code?`, `message`, `options?`, `candidates?`), `errors[]` (`code`, `field`, `message`, `suggestion?`, `candidates?`), `blockers[]` (`code`, `message`, `links`), `defaulted[]`, `warnings[]` (`prefer_proxima`, `secret_scan`, `propagation_delay`, `group_sync_delay`, `coarse_service_tree`), and, when ready, `planId`, `expiresAt`, `resolved`, `terms` (`sha`, `text`, `links`). `browser: "not opened"` means the checks failed locally and no browser was started.

### Plan codes

| Kind | Codes |
|---|---|
| `status` | `ready`, `needs_input`, `invalid`, `blocked` |
| `blockers` | `production_not_allowed`, `not_a_member`, `service_restricted` |
| `missing` | `ambiguous_person`, `ambiguous_service`, `second_owner`, `maintain_rule` (plus field-only entries for `classification`, `org`, `name`, `description`, `ownership`) |
| `errors` | `classification_invalid`, `name_invalid`, `name_unavailable`, `org_unknown`, `person_not_found`, `service_not_found`, `service_tree_invalid`, `ownership_conflict`, `too_many_owners`, `owner_duplicate`, `requester_not_found`, `requester_must_maintain`, `access_required`, `access_role_required`, `access_role_invalid`, `access_duplicate` |
| lookup failures (`ok: false`) | `forbidden`, `principal_search_failed` |

## Submit output

| `outcome` | Fields |
|---|---|
| `success` | `repo`, `webUrl`, `id`, `operationId`, `note` |
| `rejected` | `reason`, `retryable`, `problem` (`status`, `title`, `detail`, `correlationId`) |
| `partial` | `repositoryOutcome`, `failedStage`, `remediation`, `correlationId` |
| `unknown` | `repo`, `status?`, `message`, `problem?`, `contractErrors?` |
| `not_submitted` | `reason`: `requester_changed`, `not_a_member`, `name_unavailable`, `service_restricted`, `principal_changed`, `plan_mismatch`, `validation_failed`, `not_delivered`; `message` |

## Errors (`ok: false`)

`bad_args`, `auth_required`, `non_microsoft_account`, `startright_unreachable`, `plan_invalid`, `plan_mismatch`, `terms_not_accepted`, `already_submitted` (`previous`), `contract_violation`, `request_contract_violation`, `test_environment_refuses_live_write`, `guard_unavailable`, `navigation_failed`, `browser_unresponsive`, `cdp_timeout`, `session_expired`, `error`.

## State

Under `STARTRIGHT_SKILL_HOME` (default `%LOCALAPPDATA%\startright-repo-skill`, else `$XDG_STATE_HOME` or `~/.local/state/startright-repo-skill`): `profile/` (browser session: sensitive, never commit or share), `plans/` (30-minute plans), `locks/submit-*.json` (the submission journal: `prepared`, `sent`, `reconciled`). `partial` and `unknown` stay `sent`, which blocks any resubmission of that repository.
