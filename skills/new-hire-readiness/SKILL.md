---
name: new-hire-readiness
description: "Check a Microsoft employee's onboarding readiness across GitHub identity and repository access, MSX access and tooling, Azure, demo environment, training and account assignment. Use for a new-hire onboarding audit or to find what remains incomplete."
allowed-tools: Read Bash(node *new-hire-readiness.mjs check*)
compatibility: "Node.js >= 22 and the sibling check-github-access and check-msx-access skills."
metadata:
  audience: microsoft-employees
  category: onboarding
  version: "1.0.0"
---

# New-hire readiness

1. Ask which GitHub account, repositories, and minimum role are relevant. Do not copy another employee's access or assume every role needs the same resources.
2. Run `node <skill>/scripts/new-hire-readiness.mjs check --account <login> --org <organization> --repo <owner/name> --role <role> --root <MCAPS-IQ-checkout>`. Repeat `--org` and `--repo` as needed. If an authorized signed-in Microsoft 365 identity tool is available, pass its current user object ID as `--sso-user-id <object-id>` for silent MSX tooling profile matching. `--server` and `--profile` can select an existing MSX installation and Azure CLI profile.
3. Present the checks that are `action`, `unknown`, or `error`, with their next steps. Never label an unknown check complete. Azure subscriptions, demo provisioning, training, assignments, Copilot entitlement, Dual Access, MS Sales entitlement, and the required MSX role need separate verification.
   When a browser is available, review approved and pending MS Sales requests in the official portal as described by the sibling MSX skill. Report only what the portal confirms and do not infer that the approved scope covers the user's requirements.
4. For requested follow-up, use the relevant individual skill or official source. Get explicit confirmation before sending a request, changing access, accepting terms, or initiating sign-in.

The check is read-only and does not install software or submit requests. See [references/CLI.md](references/CLI.md).
