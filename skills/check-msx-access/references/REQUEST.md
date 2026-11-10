# Request MS Sales access

The access request is separate from MSX tooling: it does not require Azure CLI
sign-in, an Azure subscription, or a tooling diagnostic. Do not select or change
an Azure subscription as part of this request.

1. Use an approved browser automation tool, if available, to open [Enterprise User Access: MS Sales](https://euaaccessportal.microsoft.com/request/access/MSSales) only with an already-authenticated corporate browser session. Never start sign-in or present a credential, MFA, or account-selection prompt during readiness. If no cached authenticated session is available, mark portal status `unknown` and continue checking other areas. Inspect the live form before acting; if a field, role, or policy differs from the guidance, stop rather than guessing. Open **View/Edit My Access** and review approved and pending requests before preparing a new one. Do not duplicate an existing request; confirm whether its role and scope meet the user's need.
2. If a new or changed request is needed, gather the employee's intended role, subsidiary, applicable business scopes, and justification. Never infer these from another person. The FSI onboarding guidance names **User Account - Basic**, but confirm the role for this request.
3. Select only the values the user supplied. The documented flow uses **View/Edit My Access**, then **Edit**. Leave policy acknowledgement, signature, and submission for explicit user decisions. Do not capture or save credentials, tokens, or the user's signature.
4. Present the complete selected values and full current policy terms. Obtain a separate explicit decision immediately before each policy acknowledgement and submission. Let the user personally provide any required signature or attestation. If an already-authenticated browser session is unavailable, leave the portal result unknown rather than starting authentication.
5. Submit at most once after approval. Report a request as submitted only if the portal confirms it. If the result is ambiguous, do not resubmit; use the portal's request status or support route to reconcile it.

Manager approval and subsequent provisioning may take time. A working Dataverse connection alone does not establish that the MS Sales request or the intended MSX Dynamics role has been approved.
