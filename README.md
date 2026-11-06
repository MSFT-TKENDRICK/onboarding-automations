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
npm ci              # install the exact locked Node.js development dependencies
pip install skills-ref
python -m skills_ref.cli validate skills/request-new-azure-subscription
python -m skills_ref.cli validate skills/request-new-github-repository
python -m skills_ref.cli validate skills/check-github-access
python -m skills_ref.cli validate skills/check-msx-access
python -m skills_ref.cli validate skills/new-hire-readiness
npm test            # unit + end-to-end tests against local mock services (needs Edge/Chrome; skipped otherwise)
npm run test:unit   # unit tests only
npm run test:property  # deterministic generated invariants (seed 0x5eedc0de)
npm run test:contracts # replay external-boundary and composed JSON contracts
npm run test:mutation  # sequential targeted mutants; fails below 70%
npm run test:crap      # CRAP metric; fails for functions above 30 or missing measurement
npm run test:quality   # all quality gates above
npm run bench       # plan timings against the mock portal
```

CI validates every skill, verifies that `.claude-plugin/marketplace.json` lists each one, and runs `npm test`.
The property, contract, mutation, and CRAP commands are explicit local gates; they are not silently included in CI.

All Node test commands run with one worker and a unique `TEMP`/`TMP`/`TMPDIR`. Browser automation requests a graceful
shutdown and cleans only the throwaway profile created by that run; it never sweeps other profiles. If Windows retains
an isolated test directory after bounded cleanup, the test runner reports the path and exits nonzero. The readiness
checks are unattended: they reuse only exact,
already-authenticated account/profile matches, never start login or account selection, and report `unknown` while
continuing other checks when identity, tooling, network, or provider evidence is unavailable.

The consumer-side contract fixtures cover GitHub REST/`gh`, tenant-scoped Azure CLI token output, Dataverse `WhoAmI`, the read-only
`msx_auth_status` MCP tool, StartRight response shapes, Azure request intent decisions, and the versioned JSON contract
consumed by `new-hire-readiness`. They replay documented/provider fixtures through the real consumers; they do not
claim independent live-provider verification. Contract drift fails closed rather than being interpreted as access.

The CRAP gate uses the [crap4clj formula](https://github.com/unclebob/crap4clj#crap-formula)
`CC² × (1 − coverage)³ + CC`, Acorn AST cyclomatic complexity, and V8 per-function source-range coverage. This
approximates coverage from the unit suite using UTF-16 source offsets, excluding nested functions from their enclosing
function; it does not measure code executed inside Chromium or by integration tests. It inventories every executable
skill module, reports functions it cannot measure, and fails rather than treating missing coverage as success. Reports are written to ignored
`quality-reports/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a skill.
