# MCAPS Services portal internals (maintainers)

Load this only when the script reports form drift or you are changing the driver. These are observations of the
live portal; they can change at any time. The live page always wins, and the driver re-discovers fields and options on
every run.

## Endpoints

| Item | Value |
| --- | --- |
| Request form | `https://mcapsservices.powerappsportals.com/support/eslabs-newazuresubscription/?ServiceId=78b2e66c-42f2-e811-a96a-000d3a30da4f` |
| Short link | `https://aka.ms/MCAPSNewAzureSub` |
| Service identifier | `78b2e66c-42f2-e811-a96a-000d3a30da4f` |
| Sign-in | Power Pages `/Account/Login/ExternalLogin` → Entra ID (silent Windows/macOS SSO in Edge) |
| Own requests | Power Pages Web API (`/_api/…`), queried as the signed-in contact |

## Why a browser (not `curl`)

The form is a Power Pages basic form: ASP.NET Web Forms with `__VIEWSTATE`, `__EVENTVALIDATION` and an anti-forgery
token. Much of its behavior is client-side script, which a raw HTTP client would have to reimplement and keep in sync:
- eligibility checks
- owner/manager derivation from AD Graph
- the allowed purposes per billing offer
- the terms modal

The driver lets the portal's own script do that work in a headless browser. It then commits the resulting form POST
itself from Node, exactly once (see below).

## Load sequence and readiness

1. The server renders every purpose option. At document-ready, portal script stores them in the global
   `let subscriptionPurposeOptions` and strips the list.
2. `_api/contacts` fills hidden requester (HeadTrax) fields about 0.7 s after load.
3. `CheckPortalAccess` (host `mcapsservices-integration-prod.azurewebsites.net`) runs a corporate-network check, which
   takes about 3.5 s. On error it redirects to `/VPNRequired/`. The driver treats it as a background request: filling
   overlaps it, and the driver waits for it before finishing.
4. The purpose select gets `ui-autocomplete-loading`. After `setTimeout(2000)` then `setTimeout(3000)`, the portal
   calls `getBillingInvoiceDetailsRecords()`. That call needs `desitsm_resourcegroupname` and retries every 3 s until
   it is set. It re-adds only the purposes allowed for the requester's billing offer and removes the class. With no
   offer, `handleMissingOfferType` shows a modal and freezes the form (`no_eligible_purpose`).

The form is usable only when all of these hold:
- the form is present and no overlay is showing
- purposes exist, and the list is not still loading
- init has run

## Field behavior the driver depends on

- **Eligibility runs on type change only.** The portal checks for existing active requests when the subscription type
  changes, so the driver sets the owner *before* the type.
- **Purpose change** (Hybrid) triggers `checkMCAPsUser` → `/AdGraphGroups/GetUserGroupMemberDetails` (about 1.3 s).
  If it sets `McapsResponse` to `'False'` while an owner is set, the portal clears `itserv_businessmanager` and shows
  a modal (blocker `owner_cleared` / `mcaps_access`).
- **Owner** is a people-picker backed by `AdGraphUsers` (1.4–2.4 s). The reporting manager is derived from the owner.
- **Terms**: `const agreeTermsModalPopup` is a *detached* jQuery element and is only in the DOM while shown.
  `showTermsAndConditionModal` shows it; the Accept button `#btnftrClose` calls `showHideSubmitButton()`. The driver
  hashes the terms text (`terms.sha`) so `submit` can prove the user accepted the exact text shown.

## Terminal pages

| Path | Error |
|---|---|
| `/VPNRequired/` | `vpn_required` |
| `/NonMSUser` | `non_microsoft_account` |
| `login.microsoftonline.com` (stuck) | `auth_required` |

## Exactly-once submission

Chromium silently re-sends a POST when a reused socket is reset. That can create a duplicate subscription request, so
the browser never sends the submit. The driver works like this:
1. It captures the browser's serialized form POST at the Fetch layer.
2. It parses that body (`multipart/form-data` on the live form) and requires every verified field to appear exactly once
   with the verified value, plus the accepted terms checkbox. Anything else is blocked (`submit_body_mismatch`) and
   nothing is sent. The form is also re-read right before arming (`form_changed`).
3. It journals `prepared` → `sent` (fsynced, lock ownership re-checked) under `<state>/locks`.
4. It sends the POST once from Node and fulfils the browser's request with the response.
5. It reconciles through the Web API: `success` needs exactly one new request with the title; a confirmation-page case
   ID alone is reported as `unknown` with `probableCaseId`. `rejected` needs the re-rendered form with errors and a
   Web API query proving nothing was created.

The browser is driven over `--remote-debugging-pipe` (fds 3/4, NUL-delimited JSON), so no DevTools port is exposed.

Every other write is blocked in both `plan` and `submit`. Telemetry (App Insights SDK/CDN, 1DS, Clarity), images, fonts
and media are blocked for speed.

## Proving the live assumptions

The driver relies on six facts about the live form that the mock portal cannot prove. A maintainer proves or refutes
them all at once, read-only, after a `field_drift` or `form_drift` and before first use:

```text
node scripts/mcaps-subscription.mjs verify --pretty
```

Add `--headed` if it returns `auth_required`. Connect the VPN first (`vpn_required`). The session cannot arm or send a
submit, every portal write except sign-in is blocked, and nothing is saved. It fills the form once per purpose × type
with defaults on, then reads the page's own evidence. Exit 0 only if all six checks pass. Any `false` (refuted) or `null`
(could not run; see `detail`) gives exit 2: send the whole JSON to the skill maintainers. A pass with
`portal.live: false` came from `MCAPS_PORTAL_URL` and proves nothing about the live portal.

| # | Assumption | Check |
|---|---|---|
| A1 | The form page exposes the signed-in user as `Microsoft.Dynamic365.Portal.User` (`email` or `userName`); the owner default binds to it. | `portal_user` |
| A2 | Every Monthly Allowance label parses to an amount and the highest amount is unique; the default selects it. | `allowance_labels` |
| A3 | Every slot's control has its expected id, exactly once, with its canonical label associated. A label-tolerant or remapped binding fails. | `field_ids` |
| A4 | An enabled `Page_Validators` entry names each required slot's canonical label with `controltovalidate` on its expected id, and `validatorProof` agrees. | `validators` |
| A5 | The default zone (`MCAPS_TIMEZONE`, else the OS zone) matches exactly one Time Zone option, with an agreeing UTC offset. | `timezone_default` |
| A6 | While filling, no POST, PUT, PATCH or DELETE reaches the portal except sign-in during load, confirmed by both the guard's decisions and the browser's own network events. | `writes_blocked` |

Evidence per check is under `verify` in [CLI.md Output](CLI.md#output). Identities are masked to their first 2 characters. Identities are masked to their first 2 characters.

## Known portal issues

- An existing *active* Internal request for the same owner blocks new Internal requests (`active_request`).
- Eligibility depends on field order (see above); a human filling type before owner can bypass the check in the UI.
