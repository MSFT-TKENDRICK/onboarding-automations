---
name: request-new-azure-subscription
description: "Submit a new Azure cloud subscription request through the MCAPS Services portal when asked to create an MCAPS, ESLabs, or internal Azure subscription and return the resulting support case ID."
allowed-tools: Bash(curl:*) Read
metadata:
  audience: microsoft-employees
  category: onboarding
  version: "1.0.0"
---

# Request a new Azure subscription

Use this skill to submit an MCAPS Services request for a new MCAPS, ESLabs, or internal Azure subscription and return the resulting support case ID.

See [references/PORTAL.md](references/PORTAL.md) for portal endpoints, `curl` templates, and what to look for in the form markup.

1. **Collect request details**
   Ask for or derive every required value from the user's instructions: title, purpose, subscription type, owner, reporting manager, monthly allowance, and time zone. Treat all people and field selections as run-specific inputs; never reuse values from an earlier request. Identify missing values before contacting the portal.
2. **Load the current request schema**
   Use `curl` to GET https://mcapsservices.powerappsportals.com/support/eslabs-newazuresubscription/?ServiceId=78b2e66c-42f2-e811-a96a-000d3a30da4f (https://aka.ms/MCAPSNewAzureSub) with an authenticated portal session supplied by the user, preserve cookies in a cookie jar, and save the response for `Read`. Inspect it for the current required fields, option identifiers, form action or documented API endpoint, and anti-forgery token. Never bypass interactive authentication. If no portable HTTP submission mechanism is exposed, stop and explain that submission requires the portal UI.
3. **Validate and encode the request**
   Use `Read` to match each supplied value to an allowed current form option. Confirm every required field is populated, then construct the exact HTTP payload with the service identifier, session metadata, and anti-forgery token. Surface invalid or unavailable choices instead of silently choosing defaults.
4. **Confirm terms acceptance**
   Use `curl` with the preserved session to retrieve the portal's current terms when necessary, then use `Read` to present the current terms reference or text. Obtain the user's explicit acceptance immediately before submission. Add acceptance to the payload only after confirmation; stop if the user declines or does not accept.
5. **Submit the subscription request**
   Use `curl` to POST the validated payload to the discovered form action or documented API endpoint with the same authenticated cookie session, anti-forgery token, and required headers. Submit exactly once unless the response conclusively proves that no request was created. Never retry an ambiguous submission automatically.
6. **Verify the created case**
   Use `curl` with the preserved session to retrieve any returned status URL, save the response, and inspect it with `Read`. Require an explicit success state and support case identifier before claiming success. Report the case ID and relevant status URL. If validation fails, report the portal's field-level errors and do not resubmit automatically.
