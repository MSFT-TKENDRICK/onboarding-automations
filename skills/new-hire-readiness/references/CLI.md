# New-hire readiness check

```text
node skills/new-hire-readiness/scripts/new-hire-readiness.mjs check [--account LOGIN] [--org ORG]... [--repo OWNER/NAME]... [--role read|triage|write|maintain] [--root PATH] [--server PATH] [--profile PATH] [--sso-user-id ID] [--timeout-ms MS]
```

The check composes the sibling GitHub and MSX checks and returns their results plus explicit `unknown` checks for Azure subscription, demo environment, training, and account/pod assignment. It never treats a missing integration or an unverified item as complete. Both sibling skills must be installed beside this skill. `--timeout-ms` sets the MSX direct-profile and MCP-diagnostic timeout budgets separately (1000-300000 ms; default 180000). Pass `--sso-user-id` with the signed-in Microsoft 365 user's object ID to allow the MSX check to match existing profiles to corporate SSO.

The output is one JSON object with `schemaVersion: 1`, `kind: "new-hire-readiness"`, overall `status`, and `checks`. Each check has an `id`, `status`, `message`, and optional `next` action. Status values are `pass`, `action`, `unknown`, and `error`; overall status is `error` before `action` before `unknown` before `ready`. Exit codes are `0` for ready, `2` for action or unknown, and `1` for error.
