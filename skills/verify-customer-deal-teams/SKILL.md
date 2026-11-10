---
name: verify-customer-deal-teams
description: >-
  Verify the signed-in user's current customer account assignments from authoritative
  CRM records, find existing open opportunities, and prepare self-add deal-team
  changes for explicit human approval. Use for assigned customers, missing deal-team
  membership, personal pipeline coverage, and opportunity activity attribution.
metadata:
  category: onboarding
  version: "1.0.0"
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
3. Discover account-team schema and relationships live. Read current active
   assignments scoped to the exact user. Require an unambiguous relationship to
   exact account GUIDs and effective dates. Unknown assignment semantics, missing
   fields, stale reads, conflicting records, or incomplete pagination block the
   run. Email, meetings, vault notes, existing opportunity membership, shared
   territories, similar customer names, and confidence scores do not prove
   assignment.
4. Read existing open opportunities for those exact account GUIDs, and active
   deal-team memberships for those exact opportunity GUIDs and user. Do not
   expand to parent/child accounts or match by customer name/TPID alone.
5. Normalize only those live results into the contract documented in the
   procedure. Run `scripts/plan.mjs` with evidence stored outside the repository.
   The helper is an offline consistency checker, not an authority or a credential.
   A caller-supplied JSON file cannot itself prove customer assignment.
6. Present the proposed self-adds with resolved customer, opportunity, user, role,
   assignment record IDs, read timestamps, and expected effect. Existing members
   are no-ops. Never promise that membership alone guarantees sales credit or
   activity attribution.
7. Leave proposals pending when unattended. For each explicitly approved item,
   re-read identity, assignment, opportunity state/account, and membership
   immediately before the write; run the planner again. If anything changed,
   discard the approval and proposal. Invoke the provider's `dataverse_write`
   elicitation, never auto-approve it or replace it with direct HTTP.
8. Re-read membership after the approved write. Record `verified-added` only if
   the exact user is active on the exact opportunity. On a timeout/lost response,
   record `unknown` and reconcile read-only; never blindly retry. Never remove
   anyone, change ownership, create opportunities, or fabricate activities.
9. Keep an audit report outside Git with completed, already-member, blocked,
   pending-approval, and unknown outcomes. Include evidence IDs/times, but no
   credentials or raw mail/chat content. Report partial/incomplete scope
   explicitly; never report all customers covered after a bounded/truncated read.
