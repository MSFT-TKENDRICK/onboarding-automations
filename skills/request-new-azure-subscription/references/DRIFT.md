# Form drift and System One

Principle: **probabilities rank, proofs authorize.** Uncertainty selects the next machine action (report and stop). It never selects a field, an option the user did not ask for, or a person.

## What heals a drifted control

In order, for every named input except `owner`:

| Tier | `field_remapped.via` | Authority |
|---|---|---|
| Expected id, same label and option shape | none (no warning) | Deterministic |
| Pure rename (new id, exact same label, unique) | `renamed` | Deterministic |
| `--map <slot>=<id>` confirmed by the user | `mapped` | The user |
| Validator proof | `validator` | Deterministic, from the portal's own `Page_Validators` |

A validator proof binds a slot only when all of the following hold:

- The slot's canonical label starts the message of enabled validators that name exactly one eligible control. A
  validator's control is its `controltovalidate`, or else the id in its message's `setFocusAndScrollPosition(...)`
  (live required validators). The allowance carrier `desitsm_estimatedmonthlyspend` counts as its select.
- No validator message naming that label also names another slot's label (a compound message). A mention that falls
  entirely inside a longer label on the page does not count (for example "Secondary Subscription Owner (FTE)" for
  "Subscription Owner").
- No other slot's label points at the same control.
- The control is eligible: visible, editable, of the slot's kind and option shape, and not another slot's, a portal-populated field, another `--map` target or a `--fields` id.

The validator message is hashed into the plan (`fieldMap.<slot>.proof`), so a changed message between `plan` and `submit` is a `plan_mismatch`.

Anything else is `field_drift`, and the user confirms the control with `--map`. `field_absent` means the expected control is gone and nothing eligible or similar remains after enumerating the whole form. A model never reports absence. The owner control is never healed: any change is a `form_drift` blocker.

## System One (optional)

Set `MCAPS_SYSTEMONE_URL` to a TypeSafe-compatible endpoint, for example a local CLM server:

```
MCAPS_SYSTEMONE_URL=http://127.0.0.1:8700
```

When it is unset (the default), nothing is called and the output is unchanged. System One is used by `plan` only. `submit` and `options` never create or call the client. `submit` replays the planned effective input, which already holds the exact option values.

System One may:

- Rank the candidates of a `field_drift` entry (`rankedBy: systemone`, `candidates[].p`, `pNone`). It suggests a control only at p ≥ 0.85 with a margin ≥ 0.3 over the full eligible set. The plan still needs the user's `--map`.
- Match the user's own wording to one live option for `purpose`, `timezone`, `tenantType` or `tenantLicensing`, only when deterministic matching found no option or several. It commits only at p ≥ 0.9 with a margin ≥ 0.3, never to `none`, and never to an option whose label is shared. The result is listed in `inferred` for the user to confirm.

System One must not:

- Bind a field, make a plan ready by itself, or report a field absent.
- Touch `owner`, the manager, `allowance`, `type`, `title`, `tenantName` or any default.

Every failure (disabled, timeout, HTTP error, malformed or inconsistent answer) is treated as no answer: the plan result is the deterministic one. A refused endpoint adds a `systemone_refused` warning.

## Privacy

Requests carry opaque keys (`c1`, `o1`, …) instead of control ids. Every string is redacted first:

- the title, the owner and their alias, the tenant name, `--fields` values;
- the resolved owner's UPN and display name;
- the requester, manager and owner field values;
- URLs, e-mail addresses, GUIDs, long tokens and long digit runs.

Endpoints are loopback-only (127.0.0.1 or [::1]) unless an https host is listed in `MCAPS_SYSTEMONE_ALLOW_REMOTE`. Requests are capped at 32 KB and responses at 64 KB. There are no redirects and no retries.

## Trust limits

- Validator proofs defend against benign portal changes, not a hostile page: a page script that can rewrite its validators can also rewrite its labels.
- A malicious or buggy model can commit the wrong option for an intent slot within the allowlist. This is why `inferred` values must be confirmed with the user before `submit`.
- The redactor masks known values and common identifier shapes. It cannot recognize arbitrary personal text that a page puts into a label.
