# Policy background

The skill automates only the path Microsoft sanctions for **non-production** repositories in GitHub EMU. Sources are the internal engineering docs (eng.ms) and the StartRight wizard itself. Re-read them when the skill is updated; policy changes faster than code.

| Topic | Rule | Source |
|---|---|---|
| Production, TCB and HVT code | Not allowed on GitHub EMU. Use GitHub Proxima (<https://msft.ghe.com>) or Azure DevOps. The skill refuses these (`production_not_allowed`). | GitHub inside Microsoft (GiM): "GitHub EMU Status and GitHub Proxima" (<https://eng.ms/docs/more/github-inside-microsoft/overview/proxima>) |
| New non-TCB/HVT repositories | Preferably start in Proxima. The skill still creates in EMU when asked, and warns (`prefer_proxima`). | same |
| Proxima access | Needs the "Team Contributors" access package (<https://aka.ms/join/esme>). | same |
| New EMU organizations | Not created. Join an existing one instead. The skill never joins organizations (`not_a_member`). | same |
| Support | gim@microsoft.com, <https://aka.ms/gim/ops> | same |
| Repository creation | Self-service through StartRight (<https://startright.app.prod.gitops.startclean.microsoft.com/web/emu/>). Requires an owner (Service Tree entry, or two direct owners), at least one group or two people with `maintain`, and a non-production attestation. | StartRight wizard |
| Secret scan | A secret scan runs at creation and the results are e-mailed to the requester. | StartRight wizard |
| New Entra groups | Take about 5-6 hours to appear in GitHub (`group_sync_delay`). | GiM docs |
| Propagation | Permissions can take about a minute; the new repository may 404 briefly (`propagation_delay`). | StartRight wizard |

## Why the skill is strict

- Duplicate or exploratory submissions to StartRight are flagged as policy violations. The skill therefore never creates anything without a plan, the user's explicit acceptance of the exact terms, and a one-time journal entry per `<org>/<name>`.
- `classification` has no default. The user must say it is non-production.
- The terms text shown in a plan is written by the skill from the eng.ms policy and the StartRight wizard's attestation (`policy.mjs`, identified by `terms.sha`). It is not a verbatim copy of a StartRight legal text. If the wizard's attestation changes, update `policy.mjs`; the sha changes and old plans stop being accepted.

## Not accessible when recording

Proxima (`msft.ghe.com`) could not be opened with the recording account (Entra AADSTS 53003, Conditional Access), so the Proxima flow is guidance only and is not automated.
