# Drift: when StartRight changes

StartRight is a private service whose API can change without notice. The skill validates every response against `scripts/lib/contract.mjs`, so drift fails closed: nothing is created.

## Symptoms

| Symptom | Meaning |
|---|---|
| `contract_violation` on `plan`/`status`/`options` | A read response no longer matches the recorded shape. Nothing was created. |
| `request_contract_violation` | The skill built a request the contract rejects (a skill bug or a contract change). Nothing was sent. |
| `submit` `outcome: "unknown"` with `contractErrors` | The create answer was outside the contract. The repository may exist: never resubmit; run `status`. |
| `terms_not_accepted` after an update | The terms text changed (`terms.sha`): show the new terms. |

## Maintainer procedure

1. Run `node scripts/startright-repo.mjs verify --headed` while signed in. It replays every read-only endpoint, checks shapes and that the service rejects bad names, and proves no write was sent (`no_writes_sent`). Exit 0 only if all checks pass.
2. For each failed check, compare against the endpoint in `contract.mjs`. Capture the new shape by reading the SPA bundle or probing the GET endpoint; never invoke the create POST.
3. Update `contract.mjs`, the mock (`tests/request-new-github-repository/fixtures/mock-startright.mjs`) and `live-samples.json` (sanitize org names, people, ids and refs first), bump `CONTRACT_VERSION`, and run `npm test`.
4. If the wording of the wizard's attestation changed, update `policy.mjs` (changes `terms.sha`) and `POLICY.md`.
5. Bump the skill version in `SKILL.md`.

## Rules

- Never test a change by submitting a real request: each one is audited. Use the mock.
- Never commit the browser profile or raw probe output; they contain session data and real principal references.
