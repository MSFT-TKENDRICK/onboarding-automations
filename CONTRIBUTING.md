# Contributing

## Add a skill

1. Create `skills/<skill-name>/SKILL.md`. The directory name must equal the `name` field.
2. Add frontmatter that satisfies the [Agent Skills specification](https://agentskills.io/specification):
   - `name`: 1–64 characters, lowercase letters, digits, and single hyphens only.
   - `description`: up to 1024 characters. State what the skill does **and** when to use it, including the words a user is likely to say.
   - `allowed-tools` (optional, experimental): a **space-separated string**, for example `Bash(curl:*) Read`. Do not use a YAML list.
   - `metadata` (optional): string keys to string values. Use `category: onboarding` and a quoted `version`.
3. Write the body as numbered, imperative steps. Keep `SKILL.md` under 500 lines and move long detail into `references/` files linked one level deep.
4. Add the skill path to the `skills` array in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).
5. Add a row to the skills table in [`README.md`](README.md).
6. If the skill has scripts, add tests under `tests/<skill-name>/` (`node:test`, no dependencies) and run `npm test`.
7. Run `python -m skills_ref.cli validate skills/<skill-name>` before opening a pull request.

## Scripts

- Prefer zero-dependency Node.js (>= 22) scripts that print one JSON object on stdout and use documented exit codes, so any harness can call them and parse the result.
- Split read-only commands (safe to pre-approve in `allowed-tools`) from commands with side effects (left for the harness to confirm).
- Test against a local mock of the service that reproduces its hostile behavior (slow calls, races, lost responses). Never run tests against the live service's write paths.

## Authoring rules for onboarding skills

- **Never bypass authentication.** Skills use sessions the user establishes interactively; they never collect passwords, MFA codes, or tokens.
- **Confirm before side effects.** Get explicit user consent immediately before any submission, acceptance of terms, or change to a Microsoft system.
- **Submit once.** Never retry an ambiguous write automatically; report the outcome and let the user decide.
- **Treat inputs as run-specific.** Do not reuse people, cost centers, or selections from earlier runs.
- **Prefer the live source of truth.** Read current form options and schemas at run time instead of hard-coding them.
- **Keep secrets out of Git.** Session state (cookies, browser profiles, saved responses) belongs in the user's state directory or a temporary directory, never in the repository. Prefer the browser's own encrypted profile to exporting cookies.
