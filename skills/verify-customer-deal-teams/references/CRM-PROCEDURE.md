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
The operational guarantee is narrower: absent fresh, complete, unambiguous
authoritative evidence, produce no proposed change and perform no write.

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
   `operation: "relationships"` for `msp_accountteam`. Verify entity-set name
   `msp_accountteams`, primary key, user/account lookup targets, active-state
   values and effective-date/assignment semantics. Discover relevant Choice
   values with `operation: "choices"` when needed. Do not guess account-team
   lookup names: the known deal-team lookups are not account-team lookups.
4. Query only the authenticated user's active account assignments using the
   verified fields/relationships and server-side `eq-userid` where supported.
   Determine whether current account-team membership is authoritative evidence
   of the user's assigned coverage in this environment. If it is only an
   incidental collaboration relation, or disagrees with a current authoritative
   assignment system, stop; do not substitute meetings or pipeline ownership.
5. Resolve exact account GUIDs with `accounts`, selecting
   `accountid,name,msp_mstopparentid,statecode`. Require active accounts. Retain
   the assignment record's ID, exact user/account links and validity interval.
   Do not expand an assignment to an entire corporate family or territory.

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

## Planner input

The helper takes one JSON object. Every GUID is a canonical GUID string; GUID
case is ignored, but identities are otherwise exact. Arrays are bounded at
5000 records each. Unknown JSON fields are rejected, including auto-approval
flags. Each snapshot must be within five minutes and not in the future.
The five-minute bound is only for a proposal; pre-write revalidation remains
mandatory regardless of age.

```json
{
  "expectedIdentity": {"tenantId": "<guid>", "userId": "<guid>"},
  "identity": {
    "tenantId": "<guid>", "userId": "<guid>",
    "displayName": "Resolved current user", "role": "SE",
    "active": true, "observedAt": "<ISO date>"
  },
  "assignments": {
    "complete": true, "observedAt": "<ISO date>",
    "records": [{
      "id": "<guid>", "userId": "<guid>", "accountId": "<guid>",
      "accountName": "Resolved account", "active": true,
      "validFrom": "<ISO date or null>", "validUntil": null
    }]
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
inside the helper. Treat the result as sensitive account data.

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

Tests use synthetic records only: wrong identity/tenant, incomplete/stale reads,
effective dates, exact account scoping, active membership, duplicate/conflicting
records, bounded CLI input, and generated ordering/idempotence invariants.
The mutation runner executes a passing baseline and twelve isolated, syntax-valid
guard mutations in its own temporary directory without editing repository code.
These checks do not prove live assignment semantics, account access, provider
elicitation support, or sales-credit attribution.
