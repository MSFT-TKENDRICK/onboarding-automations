# MSX access check

```text
node skills/check-msx-access/scripts/msx-access.mjs check [--root PATH] [--server PATH] [--profile PATH] [--timeout-ms MS]
```

`--root` selects an MCAPS-IQ checkout. If omitted, `MSFTD_MCAPS_IQ_ROOT` or `MCAPS_IQ_ROOT` is used. The Azure profile is selected from `--profile`, `MSFTD_MCAPS_IQ_AZURE_CONFIG_DIR`, the checkout's `.azure`, `AZURE_CONFIG_DIR`, or the MSX server's `.azure-msx` default, in that order. The installed server defaults to the managed `~/.copilot/mcaps-iq/msx-mcp` entry point; `--server` overrides it.

For automatic identity matching, supply `--sso-user-id` with the current user's
Microsoft 365 object ID obtained from an authorized signed-in identity tool,
such as WorkIQ's `/me`. Without an explicit profile override, the check tries
the configured or checkout profile, `AZURE_CONFIG_DIR`, `~/.azure`, and
`~/.azure-msx`, using only existing directories. It never uses an identity
that does not match that object ID, and marks a match verified only after the
fixed Dataverse endpoint accepts the token. If `--profile` or
`MSFTD_MCAPS_IQ_AZURE_CONFIG_DIR` is set, that explicit choice is respected and
no other profiles are tried. A verified path is returned as `matchedProfile`
on the `msx.profile` check and used only for this diagnostic; it does not change another MCP host's
configuration. If the identity tool or a usable cached session is unavailable,
the identity remains unknown. Azure CLI may require interaction or MFA under
organization policy; this check does not bypass those requirements.

The optional tooling check requests a Dataverse token explicitly for the Microsoft tenant, then uses that token for a read-only Dataverse `WhoAmI` request. It does not require, select, or change an Azure subscription. The token is sent only in the authorization header to the fixed Dataverse endpoint; redirects are refused, and token values are not printed. The check also starts only the already-installed server and discovers its tools. It calls `msx_auth_status` only when the server marks it read-only and not destructive, without triggering login, and reports only classified results, not the account, identifier, or token. The server runs standalone with the current shell environment and selected profile: the check does not load the checkout's `.env` or prove how another MCP host resolves it. If the shell sets a nondefault `DATAVERSE_URL`, the direct and server probes are skipped rather than contacting an unverified endpoint. The direct profile probes share a 180-second timeout budget, and the MCP diagnostic has a separate 180-second total timeout; `--timeout-ms` accepts 1000-300000 to set both budgets. The server's default-account check can disagree with the tenant-scoped check; such sign-in or tenant failures are reported as unknown rather than proof of a subscription requirement. It does not install packages, sign in, or submit access requests. Unknown or changed diagnostic output is not treated as success.

Requesting MS Sales access is a separate portal workflow and requires neither
this tooling check nor Azure CLI authentication.

The installed `msx-mcp` 1.1.0 package may attempt an ordinary `az login`
without skipping subscription discovery after a data-tool token failure. Its
own status check depends on the default Azure account and applies a 30-second
timeout to CLI calls, which can misreport a working installation. This
diagnostic does not call `msx_login` or any data tool, and it cannot guarantee
that the package's unattended reauthentication will be subscription-free.

The result is one JSON object with `schemaVersion: 1`, `kind: "msx"`, an overall `status`, and `checks` containing `id`, `status`, `message`, and optional `next` fields.

Exit codes: `0` all checks ready, `2` action or verification needed, `1` error. A working connection does not verify MS Sales access, business scope, or the user's required Dynamics role. Those remain `unknown` until verified in the official portals.
