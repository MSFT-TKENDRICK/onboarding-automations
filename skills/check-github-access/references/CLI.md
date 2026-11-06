# GitHub access check

```text
node skills/check-github-access/scripts/github-access.mjs check [--account LOGIN] [--org ORG]... [--repo OWNER/NAME]... [--role read|triage|write|maintain]
node skills/check-github-access/scripts/github-access.mjs plan --account LOGIN --repo OWNER/NAME --role ROLE --recipient EMAIL --reason "JUSTIFICATION"
```

The check pins requests to github.com and uses only the exact cached `gh` account named by `--account`, without changing the active account. The account name must come from an authorized identity source. If `--account` is omitted or that cached profile is unavailable, identity is `unknown`; the command does not inspect, choose, or authenticate another account. An explicitly selected account's token is held only in the process environment of the GitHub CLI and is never printed or saved. A `_microsoft` suffix is a naming hint, not proof of managed status. It reports membership for supplied organizations, whether each supplied github.com repository is visible and, when GitHub supplies permissions, whether the requested role is present. A failed membership lookup is unknown, not proof of non-membership. `--role` defaults to `read`. No organization or repository is assumed.

`plan` validates and returns a request preview with a copy-ready subject and body. It does not send, create a persisted draft, or change permissions. Gather all fields from the user; never infer a recipient or role. Confirm immediately before any separate send.

`check` emits one JSON object with `schemaVersion: 1`, `kind: "github"`, an overall `status`, and `checks` containing `id`, `status`, `message`, and optional `next` fields.

Exit codes: `0` all checks ready, `2` action or verification needed, `1` an error. Missing Copilot and Dual Access verification is reported as `unknown`; the command does not claim complete onboarding readiness.

Microsoft EMU organization membership may be requested through [StartRight](https://aka.ms/startright) using Join Organization. Repository access is separate and is managed through its governed ACL, an approved group, or the owner's access package; there is no universal repository-access request form assumed here. The repository owner can consult [GitHub inside Microsoft](https://aka.ms/gim). For GitHub Proxima, use the appropriate [ESME access package](https://aka.ms/join/esme), identified by the owner. This command checks github.com only.
