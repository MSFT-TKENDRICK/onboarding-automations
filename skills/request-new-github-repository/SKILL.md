---
name: request-new-github-repository
description: "Create a new GitHub repository inside Microsoft (GitHub EMU, non-production) through StartRight, the sanctioned self-service path, and report its URL, or check whether such a repository exists. Use when a Microsoft employee asks to create, request, set up or spin up a new GitHub repo, sandbox repo or project repo in a Microsoft GitHub organization, or asks what happened to one. Refuses production, TCB and HVT code and points to GitHub Proxima. Not for managing existing repositories."
allowed-tools: Read Bash(node *startright-repo.mjs plan) Bash(node *startright-repo.mjs plan *) Bash(node *startright-repo.mjs options *) Bash(node *startright-repo.mjs status*) Bash(node *startright-repo.mjs verify*)
compatibility: "Node.js >= 22, Microsoft Edge or Google Chrome, corporate network or VPN, a Microsoft GitHub EMU account (<alias>_microsoft) that is a member of the target organization."
metadata:
  audience: microsoft-employees
  category: onboarding
  version: "1.2.0"
---

# Create a new GitHub repository (StartRight)

Run `node <skill>/scripts/startright-repo.mjs <command>`, where `<skill>` is this skill's directory. Each run prints one JSON object. Act on its fields (`status`, `outcome`, `error`, `found`, codes) and its `next` hint. Exit codes only classify the run: `0` the command worked, `2` needs action or nothing was created, `3` outcome unknown or partial, `1` error. Exit `0` never proves a repository exists. Flags, fields and every code: [references/CLI.md](references/CLI.md). Policy background: [references/POLICY.md](references/POLICY.md). API contract and drift: [references/STARTRIGHT.md](references/STARTRIGHT.md), [references/DRIFT.md](references/DRIFT.md).

## Rules

- `plan`, `options`, `status` and `verify` never create or change anything. `submit` creates the repository and is intentionally not pre-approved.
- **Ask the production question.** Before planning, ask: "Will this repository host production services, or contain TCB or HVT code?" Only a clear "no" allows `--classification non-production`. Never assume it, and never answer it for the user. If the answer is yes, or `blocked` is returned, do not work around it: GitHub EMU may not host that code. Send the user to GitHub Proxima (<https://msft.ghe.com>, access package "Team Contributors" from <https://aka.ms/join/esme>) or Azure DevOps, support gim@microsoft.com or <https://aka.ms/gim/ops>.
- New non-production repositories are also better started in Proxima when the user can. Mention it once (the plan's `warnings` do); the user decides.
- Never pick a value the user did not give, beyond the defaults in `defaulted`. Never choose an organization, a person, a group, a Service Tree entry or a role for the user. Ambiguity comes back as `candidates`: ask.
- Treat every value as specific to this request. Never reuse owners, groups or organizations from an earlier request.
- Show the full terms and get explicit acceptance right before every `submit`. Acceptance is a new user message sent after the complete terms of this exact plan were shown. The original request, an earlier acceptance, "just do it", a tool approval or autopilot mode is not acceptance: show the terms and wait. Pass only the `terms.sha` of the plan the user just reviewed.
- Create once. Rerun the same `submit` only after `not_submitted` or an `ok: false` error, after showing that plan's terms again and getting a new acceptance. After `rejected`, fix the values, re-plan and get acceptance for the new plan. Never submit again after `unknown`, `partial` or `already_submitted`, even if the user says "try again".
- Never edit or delete the skill's state files. Never ask for or handle passwords or MFA codes. Never call StartRight or the GitHub API any other way to create a repository.
- A repository exists only when `outcome` is `success`, or when `status` shows it. Never claim success otherwise.
- If a result is uncertain or not covered below, report its code and fields (with `message`) and stop.

## Workflow

1. **Gather** from the user: owner organization (`--org`), name (`--name`), a description (`--description`, required), the production answer, who owns it, and who gets access. Defaults: visibility `internal`. `options` helps: `options` lists the user's organizations, `options --find-service <text>` searches Service Tree, `options --org <org> --find-principal <text>` searches people and groups.
   - Ownership: `--service-tree <guid>`, `--service-tree-name <exact name>` or `--direct-owner <person>` (the requester is added as the second owner). If the user names none, the plan defaults to the requester and their manager from Microsoft Graph (see below).
   - Access: `--access "<person-or-group>=<read|triage|write|maintain>"`, repeatable. The requester is added with `maintain`. At least one group, or two people, must hold `maintain`.
   - Manager and team defaults: unless the user gives another owner, their manager becomes the second direct owner (and gets `maintain`; with a Service Tree owner the manager just gets `maintain`, since that cannot be co-ownership). Everyone else who reports to that manager is added as a default team with `write` (`--team-role read|triage|write`). Handles are `<alias>_microsoft`, each checked in StartRight by exact e-mail. Needs the Azure CLI signed in as the same person (`az login`). Opt out with `--no-manager-owner` and `--no-default-team`. `options --org <org> --show-team` previews the people and their handles without planning.
      - Teams are defined by the GiM [Policy Service](https://eng.ms/docs/more/github-inside-microsoft/policies/index.html) and [Access Control](https://eng.ms/docs/more/github-inside-microsoft/policies/access.html) pages (example: <https://github.com/gim-home/us-ss-fis-onboarding>). Roles are Read, Triage, Write, Maintain (`pull`=read, `push`=write); Admin is only by JIT, never requested here. Prefer people (immediate); a team is a mail-enabled Entra group and takes 5-6 hours. `--team-group "<exact group name>"` uses a group instead of adding people one by one, only if Graph shows it holds nobody but the manager's team at plan time (`team_group_not_directs` otherwise). Never guess a group from a name like "<manager> Directs": look-alikes hold strangers. `--show-team` lists candidate groups (`team.groups`); offer them, never pick.
   2. **Plan:**
   `node <skill>/scripts/startright-repo.mjs plan --org <org> --name <name> --description "<text>" --classification non-production --direct-owner <person> --access "<group>=maintain"`
3. **Resolve** the plan using [Plan results](#plan-results). Re-plan with the same flags plus the user's answers until `status` is `ready`.
4. **Present** the plan: every `resolved` value, every `defaulted` value (offer to change it; name the manager and each default team member with their GitHub handle and role, and offer `--no-manager-owner` or `--no-default-team`), every `warnings` entry, then the complete `terms.text` and `terms.links` verbatim.
5. **Get explicit acceptance.** Ask whether the user accepts these terms and wants this repository created. Continue only on a clear yes. Any change needs a new `plan`, new terms and a new acceptance. A plan expires at `expiresAt` (30 minutes).
6. **Submit once:**
   `node <skill>/scripts/startright-repo.mjs submit --plan <planId> --accept-terms <terms.sha>`
7. **Report** using [Submit results](#submit-results). Mention that permissions can take about a minute to propagate and that a new Entra group can take 5-6 hours to appear in GitHub.

## Plan results

| `status` | Do this |
|---|---|
| `ready` | Go to step 4. |
| `needs_input` | Handle each `missing` entry. |
| `invalid` | Handle each `errors` entry. |
| `blocked` | Report each `blockers` entry (message and links) and stop. Never work around a blocker. |

| `missing` field or code | Do this |
|---|---|
| `classification` | Ask the production question above. |
| `org`, `name`, `description` | Ask the user. For `org`, offer `options`. |
| `ownership` | Ask who owns the repository: a Service Tree entry or one other direct owner. |
| `ownership_required` | Nobody could be defaulted as owner (see the `org_defaults_skipped` or `manager_not_found` warning). Ask who owns it. |
| `default_team_too_large` | Your manager has too many reports for a default team. Ask who to add (`--access`), or use `--no-default-team`. |
| `ambiguous_person` | Show `candidates` (name, e-mail). Re-plan with the e-mail the user picks. Never pick one. |
| `ambiguous_service` | Show `candidates`. Re-plan with `--service-tree <id>` for the one the user picks. |
| `second_owner` | Ask for the other direct owner. |
| `maintain_rule` | Ask for a second maintainer (a person) or a group to add with `maintain`. |

| `errors` code | Do this |
|---|---|
| `name_invalid`, `name_too_long` | Show `message` and `suggestion` when present; ask for the name. Never rename silently. |
| `name_unavailable` | The name exists or is reserved. Ask for another. |
| `org_unknown` | Show the user's organizations (`candidates`). Ask. |
| `description_too_long`, `visibility_invalid`, `org_invalid`, `classification_invalid`, `team_role_invalid` | Show `message`; ask for a corrected value. |
| `person_not_found` | Ask for the person's exact e-mail, alias or full name (a group: its exact name); `options --find-principal` can search. |
| `team_group_not_directs` | The group holds people outside your manager's team (`outsiders`). Never override: name people with `--access`, or ask for another group. |
| `team_group_unverifiable` | Graph cannot confirm that one mail-enabled group (or is unavailable). Do not use it; offer individual defaults. |
| `team_group_conflict` | `--team-group` cannot combine with `--no-default-team`. Ask which the user wants. |
| `service_not_found`, `service_tree_invalid` | Show `message` and `candidates` when present; ask. |
| `ownership_conflict`, `too_many_owners`, `owner_duplicate`, `requester_not_found`, `access_*`, `requester_must_maintain` | Show `message`; fix the input with the user. |

| `blockers` code | Meaning |
|---|---|
| `production_not_allowed` | The code is production, TCB or HVT. Use Proxima or Azure DevOps (links in the blocker). Stop. |
| `not_a_member` | The user has not joined that organization. Joining is a manual StartRight step (Set up repository > Owner organization > Join organization). Stop. |
| `service_restricted` | StartRight blocks new repositories for that Service Tree entry. Show `message` and `links`. Stop. |

| `warnings` code | Do this |
|---|---|
| `prefer_proxima` | Mention once that new non-TCB/HVT repositories are preferably started in Proxima. The user decides. |
| `secret_scan` | Tell the user a secret scan runs at creation and results are e-mailed to them. |
| `propagation_delay`, `group_sync_delay` | Show `message`: permissions take about a minute, and a new Entra group can take 5-6 hours. |
| `coarse_service_tree` | The Service Tree entry is a Division or Organization. Ask the user to confirm that is intended. |
| `org_defaults_skipped` | Your manager and team could not be looked up, so they were not added. `reason` is one of `graph_unavailable`, `graph_unauthorized`, `graph_forbidden`, `graph_failed`, `graph_identity_mismatch` (the Azure CLI is signed in as someone else) or `no_manager`. Tell the user; for sign-in problems suggest `az login` as themselves, then re-plan. Never look the people up another way. |
| `manager_not_found` | StartRight cannot find your manager in that organization. They were not added. Ask who the second owner is. |
| `team_group_partial` | The verified group lacks some of your manager's team (named in `message`). Offer to add them with `--access`. |
| `team_members_unresolved` | Named people were not added because StartRight finds no exact match in that organization. Show them to the user; they can be added later with `--access`. |

## Submit results

| `outcome` | Do this |
|---|---|
| `success` | Report `repo` and `webUrl`. Done. |
| `rejected` | Nothing was created. Show `problem` (`title`, `detail`, `correlationId`) verbatim. If `retryable`, run `status` first. Fix the values, re-plan, and ask again. |
| `partial` | The repository may exist but a later stage failed. **Never resubmit.** Report `repositoryOutcome`, `failedStage`, `remediation` and `correlationId`; point the user to gim@microsoft.com / <https://aka.ms/gim/ops>. Run `status`. |
| `unknown` | The repository may exist. **Never resubmit.** Run `status --repo <org>/<name>` after a minute and report what it shows. If it is not visible, say the outcome is unknown and stop. |
| `not_submitted` | Nothing was created. Act on `reason`: `plan_mismatch`, `principal_changed`, `requester_changed`, `validation_failed` need a re-plan; `name_unavailable`, `not_a_member`, `service_restricted` need the cause fixed first; `not_delivered` and others may be retried once after fresh acceptance. |

## Errors (`ok: false`)

| `error` | Do this |
|---|---|
| `auth_required` | Re-run the same command with `--headed` and let the user finish sign-in in the browser window. The first time, GitHub asks the user to authorize the StartRight app: that is expected. |
| `startright_unreachable` | Ask the user to connect to the corporate network or VPN, then re-run. Nothing was created. |
| `non_microsoft_account` | The user must sign in with their `<alias>_microsoft` EMU account. Report and stop. |
| `bad_args` | Fix the command using [references/CLI.md](references/CLI.md). |
| `plan_invalid`, `plan_mismatch` | The plan expired, was changed or belongs to another service. Re-plan, present it, and ask again. |
| `terms_not_accepted` | The sha does not match the plan. Show that plan's terms again and ask. |
| `already_submitted` | A submission of this repository is journaled. Report `previous` and run `status`. Never retry and never touch the journal. |
| `contract_violation`, `request_contract_violation` | StartRight no longer matches the skill's recorded contract. Nothing was created. Report to the skill maintainers ([references/DRIFT.md](references/DRIFT.md)) and stop. |
| `test_environment_refuses_live_write` | Only occurs in automated tests. Nothing was created. |
| `guard_unavailable`, `navigation_failed`, `browser_unresponsive`, `cdp_timeout`, `session_expired`, `error` | Transient. Re-run the same command once (for `submit`, show the terms again and get acceptance first; the journal refuses anything already sent). If it repeats, report and stop. |
| `forbidden`, `principal_search_failed` | StartRight refused or failed a lookup. Report `message` and stop; retry once later. Nothing was created. |

`status --repo <org>/<name>` returns `found: false` when the repository is not visible yet: say so and check again later. Never resubmit because of it.

| Maintainer command | When |
|---|---|
| `verify` | Before first use, or after `contract_violation`: replays every read-only StartRight call against the recorded contract (exit 0 only if every check passes) and proves that no write was sent. Report its JSON to the skill maintainers. See [references/DRIFT.md](references/DRIFT.md). |

## Out of scope

Production, TCB and HVT repositories (Proxima or Azure DevOps), creating new GitHub organizations or Entra groups, joining organizations, and managing existing repositories.
