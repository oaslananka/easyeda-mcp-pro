# Agent Repository Router

These instructions apply to the entire repository. Prefer repository-owned commands and policy files over inferred conventions.

## Start here

- `README.md` for product scope and local setup.
- `CONTRIBUTING.md` for coding, testing, branching, and review rules.
- `SECURITY.md` and `docs/security-architecture.md` for trust boundaries.
- `docs/SAFETY_MODEL.md` for EasyEDA mutation safety.
- `docs/agent-runtime-config.md` for MCP-capable agent runtimes.
- `docs/benchmark-suite.md` for mocked golden evals and their limits.

## Repository map

- `src/`: MCP server, tools, bridge client, remote transport, EDA analysis, and workflows.
- `easyeda-bridge-extension/`: EasyEDA Pro runtime extension.
- `tests/`: server, policy, security, integration, and eval coverage.
- `.github/workflows/`: protected CI, security, release, and scheduled automation.
- `scripts/`: repository-owned verification, release, generation, and E2E helpers.

## Verification contract

- During iteration: run targeted tests, then `pnpm verify:fast`.
- Before handoff or PR creation: run `pnpm verify`.
- `pnpm security:audit` depends on the package registry and may fail or hang for environmental reasons; do not classify that as a repository defect without advisory evidence.
- Live EasyEDA tests are opt-in and require a connected disposable project; never substitute mocked golden evals for live-behaviour proof.

## Safety rules

- Read-only inspection may proceed without mutation.
- Require explicit user approval before the first live EasyEDA write, then preview/apply/read back and verify the result.
- Never bypass write confirmation, dependency-audit policy, release-age policy, secret hygiene, or branch protection to make a check pass.
- Do not claim manufacturing approval from automated DRC/ERC/BOM/export results.
- Treat timeouts during live writes as ambiguous state: read back before any retry.

## Change discipline

- Keep changes scoped and add regression tests for bug fixes or behaviour changes.
- Do not hand-edit generated outputs when a repository generator/check command owns them.
- Preserve pinned Node/pnpm versions and SHA-pinned GitHub Actions unless the change is an explicit runtime/dependency upgrade.
- Keep the working tree understandable: inspect `git diff` and `git status` before handoff.
