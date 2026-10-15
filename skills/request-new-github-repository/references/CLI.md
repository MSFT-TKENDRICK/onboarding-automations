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
| `options` | List organizations, search Service Tree (`--find-service`) or people/groups (`--org` + `--find-principal`, optional `--purpose acl\|ownership`), or preview your manager and default team (`--org` + `--show-team`). | No |
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
| `--direct-owner <person>` | The other owner (you are the second). Person = e-mail, alias or exact display name. Without any ownership flag, your manager is the other owner. |
| `--access "<person-or-group>=<role>"` | Repeatable. Roles: `read`, `triage`, `write`, `maintain`. You are added with `maintain`. At least one group, or two people, must hold `maintain`. |
| `--team-role <role>` | Role for the default team: `read`, `triage` or `write` (default). Never `maintain`: that would give `team_role_invalid`. |
| `--team-group "<group>"` | Use one Entra group (its exact display name) as the default team instead of adding each person. It is accepted only if Graph shows exactly one mail-enabled group with that exact name and its alias whose direct members are all people who report to your manager (or you, or the manager); members must be explicitly typed as users. Otherwise `team_group_not_directs` or `team_group_unverifiable`. Checked at `plan` time: a group's membership can change later, as with any group. Takes `--team-role`. Cannot combine with `--no-default-team` (`team_group_conflict`). |
| `--no-default-team` | Do not add the people who report to your manager. |
| `--no-manager-owner` | Do not default your manager as co-owner. Ownership is then asked for (`ownership_required`). |
| `--show-team` | `options` only: show your manager and team, their handles and whether StartRight finds each in `--org`. |
| `--json <file\|->` | The same inputs as one JSON object (`teamRole`, `teamGroup`, `noDefaultTeam`, `noManagerOwner` for the four above); flags override it. |

### Manager and default team

Unless you give ownership yourself, a plan reads three things from Microsoft Graph (read-only GETs, using your signed-in Azure CLI token): you, your manager, and your manager's direct reports.

- Your manager becomes the second direct owner and also gets `maintain`. If you name another owner, or a Service Tree entry owns the repository, your manager is not a direct owner; with a Service Tree owner they still get `maintain`, the closest access StartRight offers.
- Everyone else who reports to your manager (not you, not disabled accounts) gets `--team-role` (default `write`), up to 25 people. More returns `default_team_too_large`.
- Graph holds no GitHub handle, so a handle is derived as the documented EMU handle `<alias>_microsoft`. Nobody is added on that guess: each person must match exactly one StartRight person by e-mail in the organization, otherwise they are named in `team_members_unresolved`.
- Anyone you list with `--access` keeps the role you gave them.
- The Azure CLI must be signed in as the same person as StartRight, or the defaults are skipped (`graph_identity_mismatch`). Any Graph failure only skips the defaults, with an `org_defaults_skipped` warning whose `reason` is one of `graph_unavailable`, `graph_unauthorized`, `graph_forbidden`, `graph_failed`, `graph_identity_mismatch` or `no_manager`. Tokens are never logged or stored.

### Teams and the GiM access policy

Teams are defined by two GiM pages, returned in every plan and `--show-team` result as `references`: the [Policy Service](https://eng.ms/docs/more/github-inside-microsoft/policies/index.html) (`policyService`) and [Access Control](https://eng.ms/docs/more/github-inside-microsoft/policies/access.html) (`accessControl`). The example repository is <https://github.com/gim-home/us-ss-fis-onboarding> (`exampleRepository`).

- Access is repository-level (`.github/acl/access.yml`): `member` is a person, `team` is an Entra group (Security, M365 or Dynamic; mail-enabled preferred; not Distribution groups; nested groups are not expanded), `role` is Read, Triage, Write or Maintain. The policy's `pull` and `push` are accepted as `read` and `write`. Admin cannot be granted (`access_role_admin`): it is requested just in time.
- A new group only reaches GitHub after about 5-6 hours (`group_sync_delay`), while people added with `member` work at once. So the default team stays people. `--team-group` is opt-in and replaces the individual defaults.
- A group is never accepted on its name: look-alikes ("`<Manager>Directs`" versus "`<Manager> Directs`") can hold unrelated people. It must be exactly one mail-enabled Graph group with the same alias and display name, and every direct member must be a person who reports to your manager (or your manager, or you). Groups inside it make it `team_group_not_directs`. A group that lacks some reports is accepted with `team_group_partial`.
- `options --org <org> --show-team` lists your own groups that look like a directs group in `team.groups`, each `matches`, `partial` or `has_outsiders`. It only previews; nothing is chosen from it.

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
| `STARTRIGHT_GRAPH_TOKEN` | A Microsoft Graph access token to use instead of the one the signed-in Azure CLI gives for Graph. |
| `STARTRIGHT_GRAPH_URL` | Graph base URL (tests point it at the loopback mock; test runs refuse any other host). |

## Plan output

`status`: `ready | needs_input | invalid | blocked`. Fields: `missing[]` (`field`, `code?`, `message`, `options?`, `candidates?`), `errors[]` (`code`, `field`, `message`, `suggestion?`, `candidates?`), `blockers[]` (`code`, `message`, `links`), `defaulted[]`, `warnings[]` (`prefer_proxima`, `secret_scan`, `propagation_delay`, `group_sync_delay`, `coarse_service_tree`, `org_defaults_skipped`, `manager_not_found`, `team_members_unresolved`, `team_group_partial`), and, when ready, `planId`, `expiresAt`, `resolved`, `terms` (`sha`, `text`, `links`). `browser: "not opened"` means the checks failed locally and no browser was started.

### Plan codes

| Kind | Codes |
|---|---|
| `status` | `ready`, `needs_input`, `invalid`, `blocked` |
| `blockers` | `production_not_allowed`, `not_a_member`, `service_restricted` |
| `missing` | `ambiguous_person`, `ambiguous_service`, `second_owner`, `maintain_rule`, `ownership_required`, `default_team_too_large` (plus field-only entries for `classification`, `org`, `name`, `description`, `ownership`) |
| `errors` | `classification_invalid`, `name_invalid`, `name_unavailable`, `org_unknown`, `person_not_found`, `service_not_found`, `service_tree_invalid`, `ownership_conflict`, `too_many_owners`, `owner_duplicate`, `requester_not_found`, `requester_must_maintain`, `access_required`, `access_role_required`, `access_role_invalid`, `access_duplicate`, `access_role_admin`, `team_role_invalid`, `team_group_conflict`, `team_group_not_directs`, `team_group_unverifiable` |
| `org_defaults_skipped` reasons | `graph_unavailable`, `graph_unauthorized`, `graph_forbidden`, `graph_failed`, `graph_identity_mismatch`, `no_manager` |
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
