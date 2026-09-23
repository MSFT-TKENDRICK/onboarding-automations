# onboarding-automations

[Agent Skills](https://agentskills.io) that automate common onboarding tasks for Microsoft employees. Every skill follows the open Agent Skills specification, so any compliant agent harness (GitHub Copilot, Claude Code, Codex, and others) can load them.

## Skills

| Skill | What it does |
| --- | --- |
| [`request-new-azure-subscription`](skills/request-new-azure-subscription/SKILL.md) | Submits a new MCAPS, ESLabs, or internal Azure subscription request through the MCAPS Services portal and returns the support case ID. |

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
.github/workflows/
  validate-skills.yml # CI validation with skills-ref
```

## Install

Pick the option that matches your harness. Each skill is a self-contained directory, so you can install one or all of them.

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

The harness matches the request to the skill's `description`, loads `SKILL.md`, and follows its steps. Skills that change anything on your behalf always confirm with you before they submit.

## Validate

```bash
pip install skills-ref
python -m skills_ref.cli validate skills/request-new-azure-subscription
```

CI runs the same check on every skill and verifies that `.claude-plugin/marketplace.json` lists each one.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a skill.
