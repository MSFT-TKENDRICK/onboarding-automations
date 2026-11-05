---
name: check-github-access
description: "Check GitHub inside Microsoft identity and repository access, diagnose EMU versus personal-account confusion, and prepare the next access-request steps. Use when an employee cannot see a GitHub organization or repository, gets a 404, or is setting up GitHub access for onboarding."
allowed-tools: Read Bash(node *github-access.mjs check*) Bash(node *github-access.mjs plan*)
compatibility: "Node.js >= 22, GitHub CLI, and an existing authenticated GitHub account."
metadata:
  audience: microsoft-employees
  category: onboarding
  version: "1.0.0"
---

# Check GitHub identity and access

1. Ask which repositories and minimum role are needed. Do not infer access requirements from another employee or select a role for the user.
2. Run `node <skill>/scripts/github-access.mjs check --account <github-login> --org <organization> --repo <owner/name> --role <read|triage|write|maintain>`. Repeat `--org` and `--repo` as needed. Omit `--account` to inspect the active account. The command returns one JSON object with `pass`, `action`, `unknown`, or `error` checks.
3. Report every non-passing check and its `next` action. A 403/404 does not establish whether the repository exists or why it is inaccessible. A `_microsoft` suffix is only a naming hint; managed status, Copilot licensing, and Dual Access remain unknown unless separately verified.
4. For organization membership, [StartRight](https://aka.ms/startright) offers Join Organization where available; organization membership alone does not grant a particular private repository role. For a Microsoft EMU repository, ask the owner for its governed ACL, group, or access package; for Proxima, use the relevant Service Tree access package. To prepare a request, gather the exact account, repository, role, recipient email, and justification, then run `node <skill>/scripts/github-access.mjs plan --account <login> --repo <owner/name> --role <role> --recipient <email> --reason "<justification>"`. The plan creates a copy-ready message but sends nothing. Present it and get explicit confirmation immediately before sending through an available approved messaging tool. Do not create an invitation or modify access.

The check never changes access, requests a license, switches the active GitHub account, or prints credentials. See [references/CLI.md](references/CLI.md).
