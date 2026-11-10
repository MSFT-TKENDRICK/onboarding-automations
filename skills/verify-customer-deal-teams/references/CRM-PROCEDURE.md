# Live CRM procedure

## Trust and availability

This workflow uses the existing MCAPS-IQ MSX MCP server registered with
msft-daemon. No new credentials, login, permission grants, or direct Dataverse
write transport are permitted. Tools must be present in the live catalog;
names below describe the supported MSX native-v1 surface, not tool grants.

The provider requires human approval through MCP elicitation for every
`dataverse_write`. Scheduled runs discover and prepare proposals only. Neither
the initial automation request nor an agent-generated approval flag bypasses
that gate. Do not claim unattended additions are supported.

No system can promise literal 100% knowledge of external assignment records.
Signals and scores identify candidates; only the user's explicit selection
establishes which of those accounts they say are assigned to them. A selection
is not permission to change CRM. Incomplete candidate-source coverage must be
reported; incomplete selected-account, opportunity, or membership reads block
the proposal.

## Identity and assignment discovery

1. Verify existing authentication with `msx_auth_status`, without `msx_login`.
   Auth status text is not a user/tenant/role record. Obtain the authenticated
   identity using the server-supported identity/WhoAmI surface; do not invent
   a tool if it is unavailable. Establish the intended user and tenant from
   independently trusted current-session configuration. Unknown expected
   identity blocks the run.
2. Use `dataverse_fetchxml` on `systemusers` with
   `<condition attribute="systemuserid" operator="eq-userid" />`, selecting
   `systemuserid,fullname,title,internalemailaddress`. Require one active
   user matching the authenticated identity. Resolve the current role.
3. Use `dataverse_metadata` with `operation: "schema"` and
   `operation: "relationships"` to discover `msp_accountteam` fields, entity
   set, user/account lookup targets, and available active-state/effective-date
   semantics. Discover choices when needed. Query account-team rows scoped to
   the exact user. Do not guess lookup names or treat a row without current
   validity fields as an active assignment; record it as an `unknown` signal.
4. Discover additional exact-account associations using live metadata and
   read-only queries: account ownership, opportunity ownership, active
   opportunity deal-team membership, open opportunities attached to those
   associations, and milestone ownership. Resolve the linked account and user
   GUIDs; an open opportunity alone is not an association. Search available
   WorkIQ/M365 meetings, email, and Teams for direct user/customer engagement
   and conflicting coverage or handoff evidence. These are candidate signals,
   not proof of assignment. Associate a name-based signal only after resolving
   it unambiguously to an exact account GUID.
5. Exhaust each supported query's pages, subject to a stated record/time budget.
   Record each source as `complete`, `partial`, or `unavailable`; an unavailable
   source or missing semantic field does not prevent other candidates from
   being reviewed. Never claim complete customer coverage when any source is
   partial/unavailable, the search was bounded, or identity resolution was
   ambiguous. Do not expand to an entire corporate family or territory.

## Candidate ranking and human selection

The helper ranks normalized evidence; it does not fetch anything. Store its
input/output outside the repository. Supply every source kind below exactly
once, including unavailable sources. Every signal must be linked to the
authenticated user and the exact candidate account, with a source and record
identifier; only a `user-provided` signal may have a null `recordId`. Summaries
describe the evidence, not raw email, chat text, credentials, or instructions.
`observedAt` is the read time, not an invented event date.

```json
{
  "expectedIdentity": {"tenantId": "<guid>", "userId": "<guid>"},
  "identity": {
    "tenantId": "<guid>", "userId": "<guid>", "displayName": "Resolved user",
    "role": "SE", "active": true, "observedAt": "<ISO date>"
  },
  "discovery": {
    "observedAt": "<ISO date>",
    "sources": [
      {"kind": "account-team", "status": "partial"},
      {"kind": "account-owner", "status": "complete"},
      {"kind": "opportunity-owner", "status": "complete"},
      {"kind": "opportunity-team", "status": "complete"},
      {"kind": "open-opportunity", "status": "complete"},
      {"kind": "milestone-owner", "status": "unavailable"},
      {"kind": "m365-engagement", "status": "partial"}
    ],
    "records": [{
      "accountId": "<guid>", "accountName": "Resolved account", "active": true,
      "signals": [{
        "kind": "opportunity-team", "source": "MSX deal-team row",
        "recordId": "<source record identifier>", "userId": "<guid>",
        "observedAt": "<ISO date>", "strength": "current",
        "summary": "Active user membership on an opportunity for this account"
      }]
    }]
  }
}
```

```powershell
node skills\verify-customer-deal-teams\scripts\plan.mjs --candidates <absolute-evidence-file>
```

The 0–100 score is an uncalibrated ranking heuristic, **not** a probability,
an assignment determination, or approval. Current signals contribute:
account-team 50, account-owner 50, opportunity-owner 40, opportunity-team 55,
open-opportunity 20, milestone-owner 20, M365 engagement 15, and contradictory
`coverage-transition` −5. `user-provided` contributes zero. `unknown` strength
uses half and `historical` uses one quarter of the contribution, rounded to an
integer. Count at most the strongest contribution of each kind and clamp the
sum to 0–100. An open opportunity or transition alone is not an association.
Use `current` only when supported by live semantics; missing dates or uncertain
state are `unknown`. A `coverage-transition` signal must identify its actual
source and record, not a speculation.

Show all ranked accounts, names, exact GUIDs, scores, evidence summaries,
contradictory signals, and incomplete sources to the user. Ask which accounts
are accurately assigned to them. Use a multi-select if supported, otherwise
ask separately per account or in unambiguous batches. Do not select or infer
answers for the user. If the user names a missing account, resolve its exact
GUID, add a `user-provided` signal, rerank, and obtain a new selection for the
changed list. An unavailable or ambiguous answer leaves the run pending.

Record the actual response and its session/elicitation reference in the local
audit. Bind only the user's selections to the `candidateSetId` from the exact
list they reviewed. The hash detects changed normalized evidence; it does not
authenticate the response. The harness must obtain the real response and never
manufacture it from a caller-supplied JSON file, a score, or a previous run.
Candidate discovery and confirmation must be no more than 24 hours old, and
the confirmation must follow discovery; if the list changes or expires, rerank
and ask again. Re-read the selected accounts and current CRM state before use.

## Opportunities and membership

Batch no more than 15 GUIDs and keep each query bounded:

```text
dataverse_query:
  entity_set: opportunities
  select: opportunityid,name,_parentaccountid_value,statecode
  filter: statecode eq 0 and (_parentaccountid_value eq <ACCOUNT_GUID> ...)
  top: 200
  paginate: true
  max_records: 5000

dataverse_query:
  entity_set: msp_dealteams
  select: msp_dealteamid,_msp_dealteamuserid_value,_msp_parentopportunityid_value,statecode
  filter: statecode eq 0 and _msp_dealteamuserid_value eq <USER_GUID>
          and (_msp_parentopportunityid_value eq <OPPORTUNITY_GUID> ...)
  top: 200
  paginate: true
  max_records: 5000
```

Use machine records from `structuredContent.data.records`. Follow supported
continuations until exhausted and enforce an overall record/time budget. A
`meta.truncated` result, unresolved `hasMore`/cursor, inconsistent page, or
budget exhaustion blocks the plan; partial discovery must never justify
absence of membership. Do not invent cursor arguments: inspect live tool schema.

## Planner input after human confirmation

The helper takes one JSON object. Every GUID is a canonical GUID string; GUID
case is ignored, but identities are otherwise exact. Arrays are bounded at
5000 records each. Unknown JSON fields are rejected, including auto-approval
flags. Identity, selected account, opportunity, and membership snapshots must
be within five minutes, not in the future, and read no earlier than the user's
confirmation. The five-minute bound is only for a proposal; pre-write
revalidation remains mandatory regardless of age.

Replace `<unchanged discovery object>` with the same JSON object used for
ranking, not a string. `accounts.records` contains exactly the selected GUIDs
freshly re-read from CRM. `selectedAccountIds` must be exactly the user's
actual selections from that reviewed candidate set.

```json
{
  "expectedIdentity": {"tenantId": "<guid>", "userId": "<guid>"},
  "identity": {
    "tenantId": "<guid>", "userId": "<guid>",
    "displayName": "Resolved current user", "role": "SE",
    "active": true, "observedAt": "<ISO date>"
  },
  "assignments": {
    "source": "user-confirmed-candidates",
    "discovery": "<unchanged discovery object>",
    "accounts": {
      "complete": true, "observedAt": "<ISO date>",
      "records": [{"accountId": "<guid>", "accountName": "Resolved account", "active": true}]
    },
    "confirmation": {
      "candidateSetId": "<candidateSetId returned by ranking>",
      "userId": "<guid>", "observedAt": "<human response ISO date>",
      "selectedAccountIds": ["<guid>"]
    }
  },
  "opportunities": {
    "complete": true, "observedAt": "<ISO date>",
    "records": [{
      "id": "<guid>", "accountId": "<guid>",
      "name": "Resolved opportunity", "state": "open"
    }]
  },
  "memberships": {
    "complete": true, "observedAt": "<ISO date>",
    "records": [{
      "id": "<guid>", "userId": "<guid>",
      "opportunityId": "<guid>", "active": true
    }]
  }
}
```

Run with Node 22; the evidence file must be outside the repository:

```powershell
node skills\verify-customer-deal-teams\scripts\plan.mjs --input <absolute-evidence-file>
```

Stdout is one JSON result. Exit 0 means a consistent *proposal*, not an
approved/executed change; 2 means blocked/invalid evidence. Input and output
are bounded. No network, CRM reads/writes, authentication or approval happens
inside the helper. `candidateReview.scopeComplete` preserves incomplete source
coverage. User-confirmed proposals have no invented assignment record IDs;
their `assignmentEvidence` references the reviewed set and response time.
Treat the result as sensitive account data.

## Approved self-add and reconciliation

Load the existing MCAPS-IQ `write-gate` and `msx-write` procedures before any
write. Re-resolve role/identity live; any role can self-add, but this workflow
never adds another person. Resolve the opportunity deal-team template from
live metadata/records; do not blindly reuse a template GUID from another org.
Use only `AddUserToRecordTeam`, bound to the exact authenticated systemuser,
with an opportunity record and the resolved opportunity deal-team template.
The provider's `dataverse_write` uses `operation: "execute_action"` and takes
`data` as a JSON-encoded string:

```text
entity_set: systemusers
action_path: systemusers(<SELF_GUID>)/Microsoft.Dynamics.CRM.AddUserToRecordTeam
data: {
  "Record": {
    "@odata.type": "Microsoft.Dynamics.CRM.opportunity",
    "opportunityid": "<OPPORTUNITY_GUID>"
  },
  "TeamTemplate": {
    "@odata.type": "Microsoft.Dynamics.CRM.teamtemplate",
    "teamtemplateid": "<LIVE_RESOLVED_TEMPLATE_GUID>"
  }
}
```

Show resolved names alongside GUIDs before invoking provider elicitation. Never
write `msp_isowner`, create custom deal-team rows directly, or update ownership.
Read membership immediately before and after each write. Treat duplicate/race
responses as unknown until an exact active-membership read establishes outcome.
If a write may have succeeded but verification is unavailable, stop further
writes and report `unknown`; no blind retries. Later runs first reconcile
unknown outcomes read-only. Adding team membership does not create activities
and does not prove sales-credit attribution rules have been satisfied.

## Offline validation

```powershell
node --test tests\verify-customer-deal-teams\plan.test.mjs
node tests\verify-customer-deal-teams\mutate.mjs
python -m skills_ref.cli validate skills\verify-customer-deal-teams
```

Tests use synthetic records only: source coverage, scoring, candidate-list
binding, user selection, wrong identity/tenant, incomplete/stale reads, exact
account scoping, active membership, duplicate/conflicting records, bounded CLI
input, and generated ordering/idempotence invariants. The mutation runner
executes a passing baseline and selected isolated, syntax-valid guard mutations
in its own temporary directory without editing repository code. These checks do
not prove live discovery completeness, a human response, account access,
provider elicitation support, or sales-credit attribution.
