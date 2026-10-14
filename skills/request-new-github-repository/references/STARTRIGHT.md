# StartRight API contract

How the skill talks to StartRight, how it was recorded, and what is and is not proven.

## Approach

StartRight is a single-page app (`/web/emu/`) over a REST API at `https://startright.app.prod.gitops.startclean.microsoft.com`. Signing in is GitHub EMU SSO, so the skill drives a persistent headless Edge/Chrome profile (guarded, via CDP). Reads are `fetch` calls made inside the signed-in page. The single create call is sent from Node, after the guard authorizes it and the journal marks it sent. The browser itself may never write to the service origin.

The API was recorded by reading the SPA bundles and probing the GET endpoints while signed in. **No create request was ever sent to the live service.**

## Endpoints (source of truth: `scripts/lib/contract.mjs`)

| id | Method and path | Notes |
|---|---|---|
| `session` | `GET /api/v1/auth/github/session` | `{userId, login, avatarUrl, expiresAt, antiForgeryToken}`, or 401. Sign-in starts at `/api/v1/auth/github/oauth/start?returnUrl=`. |
| `organizations` | `GET /api/v1/resource/github/organizations` | Organizations the user belongs to. |
| `joinable` | `GET .../organizations/joinable?query=&top=` | Organizations the user could join (not automated). |
| `membership` | `GET .../organizations/{org}/membership` | |
| `availability` | `GET .../repositories/availability?organization=&name=` | `{available}`; 400 for an invalid name. |
| `principals` | `GET .../ownership/principals?organization=&purpose=acl\|ownership&query=&types=` | People and groups. `principalRef` is opaque and short-lived (about 15 minutes), so the skill re-finds principals at submit. |
| `restriction` | `GET .../ownership/restriction?organization=&serviceTreeId=` | `{blocked, message?, policyUrl?}`. |
| `catalog` | `GET /api/v1/product-catalog/products` | Service Tree entries (id, name, type). |
| `recent` | `GET .../repositories/recent` | Recently created repositories. |
| `create` | `POST .../repositories` (header `X-CSRF-TOKEN` from `session`) | Body: `{organization, repository:{name,visibility,description}, ownership:{type:"serviceTree",serviceTreeId}\|{type:"directOwners",owners:[ref,ref]}, accessControl:[{principalRef,principalType,permission}], classification:"nonproduction"}`. |

Errors are `application/problem+json`: `{status, retryable, title, detail?, correlationId, type?}`.

## Create outcomes

| Response | Outcome | Journal |
|---|---|---|
| `201` | `success` | settled |
| `400`, `401`, `403`, `409` | `rejected` | settled, may be re-planned |
| `429`, `503` | `rejected`, `retryable` | settled |
| `500` with `failureKind: "partialFailure"` | `partial` | stays `sent` |
| anything else, a malformed body, no answer | `unknown` | stays `sent` |

## Not proven

- The `201` body shape is inferred from the SPA code, never observed. The skill tolerates a missing body on success.
- Whether a `principalRef` is bound to the organization and purpose (the mock assumes it is), whether `recent` is global, and whether the requester must be among direct owners are unverified. `verify` and the sanitized fixtures cover only GET behavior.
- The sanitized live fixtures (`tests/request-new-github-repository/fixtures/live-samples.json`) lack catalog, organizations and recent samples, because the probe bodies were truncated when captured.

## Contract testing

`tests/request-new-github-repository/fixtures/mock-startright.mjs` is an independent loopback implementation of the contract. It checks every request and response with `checkRequest`/`checkResponse` and records violations, and `cli.integration.test.mjs` drives the real CLI and headless browser against it, with every `createMode` (success, conflict, forbidden, rate limit, 503, partial, 500s, dropped connections). The guard has a kill switch: under `node --test` any create to a non-loopback host throws `test_environment_refuses_live_write`.

## Authorization during recording

Recording required one browser sign-in, which authorized the "StartRightPROD" GitHub OAuth app (no scopes) for the recording account. Every user of the skill sees the same one-time GitHub prompt.
