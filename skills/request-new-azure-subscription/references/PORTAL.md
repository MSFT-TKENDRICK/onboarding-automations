# MCAPS Services portal reference

Load this file only when you need concrete endpoints or `curl` patterns. The portal can change at any time; always trust the live form markup over anything written here.

## Endpoints

| Item | Value |
| --- | --- |
| Request form | `https://mcapsservices.powerappsportals.com/support/eslabs-newazuresubscription/?ServiceId=78b2e66c-42f2-e811-a96a-000d3a30da4f` |
| Short link | `https://aka.ms/MCAPSNewAzureSub` |
| Service identifier | `78b2e66c-42f2-e811-a96a-000d3a30da4f` |

## Session handling

- The user signs in interactively in their own browser and supplies the authenticated session (for example, an exported Netscape-format cookie file). Never ask for passwords, MFA codes, or tokens, and never script the sign-in flow.
- Keep the cookie jar and saved responses in a temporary working directory outside any Git repository. Treat them as secrets and delete them when the run ends.
- If a response redirects to `login.microsoftonline.com` or renders a sign-in page, stop and ask the user to refresh their session.
- On Windows, call `curl.exe` explicitly so Windows PowerShell does not resolve `curl` to `Invoke-WebRequest`.

## Load the form

```bash
curl -sS -L \
  -b "$JAR" -c "$JAR" \
  -o form.html \
  -w '%{http_code} %{url_effective}\n' \
  'https://mcapsservices.powerappsportals.com/support/eslabs-newazuresubscription/?ServiceId=78b2e66c-42f2-e811-a96a-000d3a30da4f'
```

Confirm a `200` status and that the effective URL is still on `mcapsservices.powerappsportals.com` before reading `form.html`.

## What to inspect in the markup

Power Pages (Power Apps portals) forms are typically ASP.NET Web Forms. Use `Read` on the saved HTML and capture:

- The `<form>` element's `action` and `method`.
- Every hidden input, commonly including `__RequestVerificationToken`, `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, `__EVENTTARGET`, and `__EVENTARGUMENT`. Post them back unchanged.
- Required fields, indicated by `required`, `aria-required="true"`, a `required` CSS class on the label, or associated validator elements.
- For each `<select>`, the `value` and visible label of every `<option>`. Lookups often use GUIDs and choice fields often use integer values; always post the `value`, never the label.
- The submit button's `name` and `value`, which Web Forms usually requires in the POST body.
- The terms-of-use checkbox or link, if present.

If the page renders its fields only through client-side script and exposes no form action or documented API endpoint, stop: submission requires the portal UI.

## Submit exactly once

```bash
curl -sS \
  -b "$JAR" -c "$JAR" \
  -o submit.html \
  -D submit.headers \
  -w '%{http_code} %{redirect_url}\n' \
  -H 'Origin: https://mcapsservices.powerappsportals.com' \
  -H "Referer: $FORM_URL" \
  --data-urlencode "__RequestVerificationToken=$TOKEN" \
  --data-urlencode "<field-name>=<field-value>" \
  "$FORM_ACTION"
```

- Repeat `--data-urlencode` for every hidden input, required field, the acceptance field (only after explicit user consent), and the submit button.
- Do not pass `-L` on the POST; inspect `submit.headers` and the status first so a redirect cannot trigger a second submission.
- A timeout, connection reset, or unexpected status is an ambiguous outcome. Report it and let the user check the portal before anything is retried.

## Verify the result

- Follow any `Location` header or status URL with a GET using the same cookie jar and save the response.
- Treat the request as successful only when the portal shows an explicit success state and a support case identifier.
- On failure, extract the validation summary (commonly an element with a `validation-summary` class) and report each field-level error verbatim.
