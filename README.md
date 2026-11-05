# onboarding-automations

[Agent Skills](https://agentskills.io) that automate common onboarding tasks for Microsoft employees. Every skill follows the open Agent Skills specification, so any compliant agent harness (GitHub Copilot, Claude Code, Codex, and others) can load them.

## Skills

| Skill | What it does |
| --- | --- |
| [`request-new-azure-subscription`](skills/request-new-azure-subscription/SKILL.md) | Submits a new MCAPS, ESLabs, or internal Azure subscription request through the MCAPS Services portal and returns the support case ID. Uses a zero-dependency Node script that drives headless Edge over the DevTools protocol with your corporate SSO; see its [benchmarks](skills/request-new-azure-subscription/references/BENCHMARKS.md). |
| [`request-new-github-repository`](skills/request-new-github-repository/SKILL.md) | Creates a new non-production GitHub EMU repository through StartRight, the sanctioned self-service path, and returns its URL. Refuses production, TCB and HVT code and points to GitHub Proxima. Contract-tested against a local mock: the live create call is never exercised by tests. |
| [`check-github-access`](skills/check-github-access/SKILL.md) | Checks the selected GitHub identity and specified repositories, without changing access. |
| [`check-msx-access`](skills/check-msx-access/SKILL.md) | Guides MS Sales access requests and separately checks corporate SSO and MSX tooling. |
| [`new-hire-readiness`](skills/new-hire-readiness/SKILL.md) | Combines the GitHub and MSX checks and identifies onboarding areas that still require verification. Install both sibling checks with it. |

## Requirements

Skills with scripts need **Node.js 22 or later**. Browser-driven skills also need Microsoft Edge or Google Chrome, and
access to the corporate network (VPN).

## Repository layout

```
skills/
  <skill-name>/
    SKILL.md          # Required: frontmatter + instructions
    references/       # Optional: detail loaded on demand
    scripts/          # Optional: executable helpers
    assets/           # Optional: templates and data
.claude-plugin/
  marketplace.json    # Plugin marketplace manifest listing every skill
tests/
  <skill-name>/       # node:test unit tests, mock services, integration tests
.github/workflows/
  validate-skills.yml # CI: skills-ref validation + npm test
```

## Install

Pick the option that matches your harness. You can install individual skill directories or all of them. The
`new-hire-readiness` skill also requires its sibling `check-github-access` and `check-msx-access` directories.

### Plugin marketplace (Claude Code, GitHub Copilot CLI)

```text
/plugin marketplace add MSFT-TKENDRICK/onboarding-automations
/plugin install onboarding-skills@microsoft-onboarding
```

### Copy into a skills directory (any harness)

Clone the repository, then copy or symlink the skill directories into the location your harness scans:

| Harness | Personal skills | Project skills |
| --- | --- | --- |
| GitHub Copilot (CLI, VS Code, coding agent) | `~/.copilot/skills/` | `.github/skills/` |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.codex/skills/` | — |
| Other harnesses | See the harness documentation | See the harness documentation |

```bash
git clone https://github.com/MSFT-TKENDRICK/onboarding-automations.git
cp -r onboarding-automations/skills/* ~/.copilot/skills/
```

```powershell
git clone https://github.com/MSFT-TKENDRICK/onboarding-automations.git
Copy-Item -Recurse onboarding-automations\skills\* $HOME\.copilot\skills\
```

## Use

Ask your agent in plain language, for example:

> Request a new ESLabs Azure subscription for my team's demo environment.

> Check my GitHub and MSX onboarding readiness for the repositories my team uses.

The harness matches the request to the skill's `description`, loads `SKILL.md`, and follows its steps. Skills that change anything on your behalf always confirm with you before they submit.

An MS Sales access request does not require an Azure subscription or Azure CLI sign-in.

## Validate

```bash
pip install skills-ref
python -m skills_ref.cli validate skills/request-new-azure-subscription
python -m skills_ref.cli validate skills/request-new-github-repository
python -m skills_ref.cli validate skills/check-github-access
python -m skills_ref.cli validate skills/check-msx-access
python -m skills_ref.cli validate skills/new-hire-readiness
npm test            # unit + end-to-end tests against local mock services (needs Edge/Chrome; skipped otherwise)
npm run test:unit   # unit tests only
npm run bench       # plan timings against the mock portal
```

CI runs the same checks on every skill and verifies that `.claude-plugin/marketplace.json` lists each one.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a skill.
