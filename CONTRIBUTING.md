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
6. Run `python -m skills_ref.cli validate skills/<skill-name>` before opening a pull request.

## Authoring rules for onboarding skills

- **Never bypass authentication.** Skills use sessions the user establishes interactively; they never collect passwords, MFA codes, or tokens.
- **Confirm before side effects.** Get explicit user consent immediately before any submission, acceptance of terms, or change to a Microsoft system.
- **Submit once.** Never retry an ambiguous write automatically; report the outcome and let the user decide.
- **Treat inputs as run-specific.** Do not reuse people, cost centers, or selections from earlier runs.
- **Prefer the live source of truth.** Read current form options and schemas at run time instead of hard-coding them.
- **Keep secrets out of Git.** Cookie jars and saved responses belong in a temporary directory outside the repository.
