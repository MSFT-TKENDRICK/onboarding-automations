---
name: check-msx-access
description: "Check MS Sales and MSX onboarding, the MCAPS-IQ MCP configuration, and the current user's MSX authentication and connection. Use when an employee needs MSX access, cannot connect to Dataverse, or needs to set up MSX tooling."
allowed-tools: Read Bash(node *msx-access.mjs check*)
compatibility: "Node.js >= 22; an installed MSX MCP server and an existing Azure CLI sign-in are needed for the live diagnostic."
metadata:
  audience: microsoft-employees
  category: onboarding
  version: "1.0.0"
---

# Check MSX access and tooling

1. If MS Sales access is needed, follow the guarded [request workflow](references/REQUEST.md) using the live [Enterprise User Access: MS Sales](https://euaaccessportal.microsoft.com/request/access/MSSales) form. An Azure CLI sign-in or Azure subscription is not a prerequisite. Select values only from the user's answers. Get explicit acceptance immediately before any submission. Never enter credentials or MFA codes.
   First inspect existing approved and pending requests; do not create a duplicate.
2. For the separate tooling diagnostic, run `node <skill>/scripts/msx-access.mjs check --root <MCAPS-IQ-checkout>`. Obtain the current user's object ID from an authorized signed-in Microsoft 365 identity tool if available and pass `--sso-user-id <object-id>`. If it is unavailable, omit the flag and keep identity matching unknown. Use `--server <installed-msx-js>` or `--profile <azure-profile>` only when needed. The check silently reuses existing sessions, discovers the server's tools, and calls only `msx_auth_status`; it never installs, starts interactive sign-in, changes a subscription, or submits a request.
3. Report every `action`, `unknown`, and `error` check. This standalone check does not load the checkout's `.env` or verify another MCP host's configuration. A successful Dataverse connection is not proof of MS Sales entitlement or the correct Dynamics role.
4. If a Dynamics role is needed, use the [MSX Access Manager guide](https://eng.ms/docs/experiences-devices/business-and-industry-copilot/bic-cxp/sales-platform/sales-platform-ux/msx-platform/docs/accessmanageronboarding). Never infer a role or copy another person's access without the user's decision.

See [references/CLI.md](references/CLI.md) for profile selection, results, and limitations.
