---
name: request-new-azure-subscription
description: "Submit a new Azure cloud subscription request through the MCAPS Services portal when asked to create an MCAPS, ESLabs, or internal Azure subscription and return the resulting support case ID."
allowed-tools: Read Bash(node *mcaps-subscription.mjs plan *) Bash(node *mcaps-subscription.mjs options *) Bash(node *mcaps-subscription.mjs status*)
compatibility: "Node.js >= 22, Microsoft Edge or Google Chrome, corporate network or VPN, a Microsoft corporate account (Windows or macOS SSO)."
metadata:
  audience: microsoft-employees
  category: onboarding
  version: "2.0.0"
---

# Request a new Azure subscription

Use this skill to submit an MCAPS Services request for a new MCAPS, ESLabs, or internal Azure subscription and return the resulting support case ID.

All portal work goes through one script, `scripts/mcaps-subscription.mjs` (run it with the skill directory's path). It drives a headless Edge over the DevTools protocol (a private pipe, no network port) using the user's own corporate SSO. It prints one JSON object on stdout. It blocks every write to the portal except the single submission, and that POST can only carry the values verified in the plan. Exit codes: `0` command succeeded, `2` needs input/blocked/not submitted/rejected/not found, `3` outcome unknown, `1` error. [references/CLI.md](references/CLI.md) documents every flag, output field and error code.

1. **Collect request details**
   Take the values the user gave; everything else has a safe default that `plan` fills in and reports in `defaulted`:

   | Field | Default when not given |
   |---|---|
   | subscription type | `internal` (external needs the tenant fields) |
   | monthly allowance | the highest amount offered |
   | owner (alias, email or full name) | the signed-in user |
   | time zone | this computer's zone (`MCAPS_TIMEZONE` overrides); asked for when it matches no single option |
   | title | `<owner alias> Azure subscription <YYYY-MM-DD>` |
   | purpose, tenant fields | the option, when the portal offers exactly one; otherwise asked for |

   Treat all people and field selections as run-specific inputs; never reuse values from an earlier request. The portal derives the reporting manager from the owner; if the user named a different manager, point out the discrepancy. If you don't know which options are valid, run `node <skill>/scripts/mcaps-subscription.mjs options --type internal` and offer the current lists. Pass `--no-defaults` when the user wants to choose every value.
2. **Plan against the live form (never submits)**
   Run `plan` with the values the user gave, for example:
   `node <skill>/scripts/mcaps-subscription.mjs plan --purpose "Hybrid"` or, fully specified,
   `node <skill>/scripts/mcaps-subscription.mjs plan --title "…" --purpose "…" --type internal --owner alias@microsoft.com --allowance 500 --timezone "Pacific Time"`.
   Plan fills the live form with writes blocked. It then matches each value to the current option lists, runs the portal's own eligibility checks, derives the manager, reads the current terms and saves a `planId`.
   - `needs_input` / `invalid`: ask the user about each entry in `missing` / `errors`, offering the listed options. Never pick a value yourself beyond the documented defaults.
   - `blocked`: report each blocker (for example an existing active request, or an owner without MCAPS access) and stop.
   - Errors: `vpn_required` or `portal_unreachable` means check the corporate network/VPN and rerun. `auth_required` means rerun with `--headed` and let the user finish sign-in in the window; never handle their credentials. `no_eligible_purpose` means report the portal's message.
3. **Present the plan**
   Show the resolved values, calling out every `defaulted` value so the user can override it (re-run `plan` with the changed flag), the derived manager, any `warnings` (especially `possible_duplicate`), and the complete terms text from `terms.text`.
4. **Confirm terms acceptance**
   Ask the user to explicitly accept those terms immediately before submission. Stop if they decline, hesitate, or change any value. A changed value needs a new `plan`. Only use the `terms.sha` from the plan the user just reviewed; never reuse one from an earlier run or copy it without showing the terms.
5. **Submit the subscription request exactly once**
   Only after acceptance, run `node <skill>/scripts/mcaps-subscription.mjs submit --plan <planId> --accept-terms <terms.sha>`. This command is intentionally not pre-approved. Submit re-verifies the live form against the plan and refuses if anything changed (`plan_mismatch`, `form_changed`, `submit_body_mismatch`). It then sends a single POST and journals it, so the same request can never be sent twice.
   - Never pass `--allow-duplicate` unless the user saw the duplicates (or the earlier successful case) and explicitly asked for another identical request.
   - Never rerun `submit` after `unknown`, and never edit or delete the skill's state files (`plan_invalid` means re-run `plan`).
6. **Verify the created case**
   The request exists only when `outcome` is `success` and `caseId` is present; exit code 0 alone is not proof.
   - `success`: report `caseId` and `status`.
   - `rejected`: report the portal's field-level `errors` (`field`, `message`) verbatim. Nothing was created, so a corrected plan may be submitted after the user agrees.
   - `not_submitted`: explain the `reason`. Nothing was sent, so the same plan may be submitted again once the cause is fixed.
   - `unknown`: tell the user the request may exist. Do not resubmit. If `probableCaseId` is present, run `status --case <probableCaseId>` (`found: true` confirms it). Otherwise run `status` after a few minutes and report what it shows.
   Never claim success without a confirmed case ID.
