# Benchmarks and optimization log

Timings are wall-clock for `plan` (launch → sign-in → form ready → fill → read terms → close). They were measured
live against the production MCAPS Services portal on a corporate Windows device with Edge headless, and against the
mock portal (`node tests/request-new-azure-subscription/bench.mjs 5`, median of 5). `submit` is the same pipeline plus
a single Node-issued POST, adding about 1–3 s of server time.

| Round | Change | Live `plan` | Notes |
|---|---|---|---|
| 0 | First working driver (raw CDP, Edge headless, SSO) | ~29 s | ~16–22 s of that was `formQuiet` waiting on a single slow request |
| 1a | Block telemetry (App Insights SDK/CDN, 1DS, Clarity) at the Fetch layer | ~12 s (incorrect) | Faster runs exposed a form-readiness race, see 1b |
| 1b | Treat the document-ready VPN check (`CheckPortalAccess`, ~3.5 s) as *background*: fill overlaps it and `finish` drains it, then re-checks the page. Fix readiness: wait for the purpose list to be stripped, rebuilt by the billing-sections XHR, and for `ui-autocomplete-loading` to clear | ~18 s | Correct on every run |
| 2 | Persistent Edge profile under `<state>/profile`. Portal-host session cookies promoted to an 8 h expiry just before a graceful `Browser.close` so Chromium persists them | 14–17 s warm | SSO skipped; `formReady` 11.5 s → 8.9 s; close 0.6–1.9 s |
| 3 | Network trace (`MCAPS_TRACE_NET=1`) floor analysis; optimizations below rejected | — | Remaining time is portal- or server-bound |
| 4 | Security round (adversarial review): CDP over `--remote-debugging-pipe` instead of a TCP port + `DevToolsActivePort` polling. Readiness = first `Browser.getVersion` reply | Not re-measured (portal unreachable from this machine at the time) | Mock: `browserLaunched` ≈ 0.5 s, wall 4.5 s (unchanged). No localhost DevTools endpoint; the browser exits ~1 s after the driver dies. Submit POST is now bound field by field to the verified values (no measurable cost) |

Mock portal medians (5 runs, same machine): persistent 4.8 s, ephemeral 4.5 s (round 4: 4.6 s / 4.5 s). The mock signs in instantly, so the
persistent win only shows live. On the mock, graceful close costs about 0.3 s.

## Where the time goes (live, warm)

| Phase | ms | Bound by |
|---|---|---|
| Edge launch + CDP attach | ~450 | local |
| Form HTML + scripts | ~1,500 | network |
| Portal init: `_api/contacts`, VPN check, then idle timers `setTimeout(2000)` → `setTimeout(3000)` → billing-sections XHR | ~7,000 | **portal timers** (~5 s of pure idle) |
| Fill: purpose → `GetUserGroupMemberDetails` ~1.3 s; owner → `AdGraphUsers` 1.4–2.4 s; manager derived | ~5,500 | **backend AD/Graph calls** |
| Terms + close | ~1,000 | local |

## Rejected optimizations (adversarial review)

- **Firing the portal's init timers early.** The idle `setTimeout(2000)`/`setTimeout(3000)` chain guards
  `getHtDataWithRequetorAlias`. That function copies hidden requester fields that `_api/contacts` populates about 0.7 s after
  load. Calling `getBillingInvoiceDetailsRecords()` ourselves would double-append purpose options, and the portal's own
  timer would still fire and mutate the form mid-fill. This saves ~5 s but risks a silently wrong payload.
- **Overlapping owner entry with the purpose-triggered `checkMCAPsUser`.** Its success handler sets `McapsResponse` and,
  when `False` with an owner present, *clears the business manager* and shows a modal. That result belongs to whichever
  owner was current when it returned, so overlap can attach a stale eligibility result to the new owner.
- **Letting Chromium submit the form.** Chromium silently re-sends a POST when the socket is reset, which can create a
  duplicate subscription request. Node sends the single POST itself, with a journal (`prepared` → `sent`, fsynced) and
  API reconciliation.
- **Force-killing Edge on close.** It saves ~1 s but loses cookies, because the SQLite cookie store commits lazily
  (~30 s), so the next run has to sign in again.
- **Skipping `formQuiet`.** The eligibility checks run only on field change. Filling before the portal's handlers finish
  lets the portal clear fields afterwards (`owner_cleared`). The driver detects that and reports it rather than racing it.
- **Reusing a long-lived browser (daemon, `--remote-debugging-port`).** It would save ~0.5 s launch, but it leaves an
  authenticated debugging endpoint open on localhost. Rejected on security grounds; the persistent profile gets most of
  the benefit. The driver itself now uses a private pipe, so no run ever exposes a DevTools port.
