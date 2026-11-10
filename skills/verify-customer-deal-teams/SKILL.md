---
name: verify-customer-deal-teams
description: >-
  Discover and score candidate customer accounts, ask the signed-in user which are
  assigned to them, and find missing deal-team memberships on existing opportunities.
  Prepare self-adds for explicit human approval. Use for assigned customers, personal
  pipeline coverage, and opportunity activity attribution.
metadata:
  category: onboarding
  version: "1.3.0"
---

# Verified customer deal teams

1. Read [the live CRM procedure](references/CRM-PROCEDURE.md). Use the configured
   MCAPS-IQ MSX MCP server through msft-daemon/the current harness. Never start
   login, select another account, or change permissions. If unavailable, report
   `blocked` and stop without writes.
2. Resolve the authenticated tenant and user server-side, compare both GUIDs with
   the run's independently established expected identity, and resolve the user's
   role. Never infer identity from a display name, an email mention, GitHub
   identity, the active Azure subscription, or a cached account list.
3. Discover candidate accounts from account-team and owner records, opportunity
   ownership and deal-team memberships, milestone ownership, and available
   WorkIQ/M365 engagement. Exhaust supported pagination and disclose unavailable
   or partial sources. Unknown effective dates or assignment semantics lower a
   signal's strength; they do not prevent candidate discovery. Neither a source
   record nor a score proves assignment.
4. Always run `scripts/plan.mjs --customers` and ask the user which named
   customers are assigned to them, even when every CRM match is unambiguous.
   Show every name, score, evidence, contradictory signals, and incomplete
   source coverage. This preliminary review does not select or confirm any CRM
   account and cannot authorize planning or writes. Preserve the real response
   and reviewed set; never infer or manufacture an answer.
5. Resolve exact active CRM account GUIDs for the selected names, without
   guessing among duplicate records or expanding to related accounts. Present
   distinguishing evidence when a user must disambiguate. Stop if a selected
   customer cannot be resolved; do not silently discard or merge names.
6. Normalize the exact-account evidence and run `scripts/plan.mjs --candidates`
   with the reviewed name set, actual name selection, and explicit mappings
   from selected names to candidate account GUIDs, as documented in the
   procedure. Present every ranked account with its exact GUID, score,
   evidence, contradictory signals, and incomplete source coverage. Scores are
   uncalibrated heuristics, not probabilities or authorization.
7. Ask the user which exact accounts are accurately assigned to them, using a
   multi-select or individual questions. A user-supplied missing account must be
   resolved to an exact GUID and included in a new review. A preliminary
   name-level selection is not this confirmation. Never answer on the user's
   behalf. If the user is unavailable or the answer is unclear, stop with the
   selection pending. Only explicitly selected exact accounts proceed.
8. Bind the real exact-account response to the reviewed candidate set as described in
   the procedure. Re-read those exact active accounts, their existing open
   opportunities, and active deal-team memberships. Do not expand to related
   accounts or match by name/TPID alone. Incomplete account, opportunity, or
   membership reads block proposals; partial candidate discovery remains visible.
9. Run `scripts/plan.mjs --input` with evidence outside the repository. This
   offline helper checks consistency; a JSON file or a candidate-set hash is
   neither proof of a human response nor permission to write.
10. Present the proposed self-adds with customer, opportunity, user, role,
   confirmation evidence, and read timestamps. Existing members are no-ops.
   Never promise membership alone guarantees sales credit or activity attribution.
11. Leave proposals pending when unattended. Immediately before each write,
   re-read identity, confirmed account, opportunity state/account, and
   membership and run the planner again. If the reviewed account or scope
   changes, obtain a new user selection. Discard changed proposals and show any
   revised proposal before approval; skip an opportunity if membership now exists.
   Use an interactive MCP path that can deliver the provider's
   `dataverse_write` elicitation to the real user. The daemon's shared
   upstream registry and CodeAct tool dispatcher do not support elicitation;
   never use them for these writes. If the approval path or user is unavailable,
   leave the proposal pending. Never auto-approve or replace provider
   elicitation with direct HTTP.
12. Re-read membership after the approved write. Record `verified-added` only if
   the exact user is active on the exact opportunity. On a timeout/lost response,
   record `unknown` and reconcile read-only; never blindly retry. Never remove
   anyone, change ownership, create opportunities, or fabricate activities.
13. Keep an audit report outside Git with completed, already-member, blocked,
   pending-approval, and unknown outcomes. Include evidence IDs/times, but no
   credentials or raw mail/chat content. Report partial/incomplete scope
   explicitly; never report all customers covered after a bounded/truncated read.
