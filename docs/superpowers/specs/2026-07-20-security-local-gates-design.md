# Local Security Gates Design

## Goal

Add fast, deterministic local security feedback for Semgrep, Snyk, and SonarQube Cloud without duplicating slow cloud analysis on every commit.

## Decisions

- Semgrep Community Edition `1.170.0` runs on staged files at `pre-commit` and performs a complete repository scan in GitHub Actions.
- The Semgrep rules are stored in `.semgrep.yml`; no registry configuration or cloud token is required for the local or CI scan.
- The local rules block only high-confidence hazards: dynamic code execution, shell-backed child processes, and disabled TLS certificate verification.
- Snyk CLI `1.1306.1` is version-pinned through `pnpm dlx`. The Open Source scan runs at `pre-push`; Snyk Code remains an explicit developer command and the existing GitHub App remains the PR scanner.
- A failed or unauthenticated Snyk scan blocks the push. Emergency bypasses must be explicit through pre-commit's `SKIP=snyk-oss` mechanism and do not replace required PR checks.
- SonarQube Cloud remains a PR quality gate. Developers use SonarQube for IDE Connected Mode for pre-commit feedback rather than running a local Sonar scanner hook.
- No security token, organization identifier, or developer credential is committed to the repository.

## Components

1. `.pre-commit-config.yaml` installs both `pre-commit` and `pre-push` hooks, adds secret/large-file/case checks, runs Semgrep on staged files, and runs Snyk Open Source before push.
2. `.semgrep.yml` contains repository-owned rules, `.semgrepignore` excludes generated files, dependencies, documentation, and intentional rule fixtures, and `scripts/test-semgrep-rules.mjs` provides cross-platform rule-test execution.
3. `package.json` exposes version-pinned security commands.
4. `.github/workflows/static-security-analysis.yml` validates and tests the Semgrep rules, scans the full repository, and uploads SARIF for trusted events.
5. `tests/unit/repository/security-tooling-policy.test.ts` prevents accidental removal or weakening of the security-tooling contract.
6. `tests/semgrep/security-rules.ts` proves positive and negative rule behavior.
7. `docs/development/security-tooling.md` documents installation, authentication, Connected Mode, normal commands, and controlled bypass behavior.

## Failure Behavior

- A Semgrep finding or invalid rule configuration fails the commit and CI job.
- A Snyk high-or-critical dependency finding, missing authentication, or CLI execution failure fails the pre-push hook.
- SonarQube Cloud findings continue to be governed by the repository's PR Quality Gate.
- Generated files and test fixtures are excluded intentionally; production source and operational scripts remain in scope.

## Verification

- Run the repository policy test before and after implementation to demonstrate red-green behavior.
- Run Semgrep rule tests and a full local Semgrep scan.
- Validate `.pre-commit-config.yaml` and exercise all non-Snyk hooks locally.
- Run `pnpm verify` on Node.js `24.18.0`.
- Open a PR and require GitHub CI, Dependency Review, Semgrep Static Security Analysis, Snyk, and SonarQube Cloud to report.
