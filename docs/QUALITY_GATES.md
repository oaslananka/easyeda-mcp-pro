# Changed-code quality gates

Pull requests are protected by two provider-owned changed-code checks:

| Check context              | Owner              | Blocking rule                                                                                                  |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `codecov/patch`            | Codecov GitHub App | At least 80% patch coverage, with a two-percentage-point tolerance. Missing coverage or failed CI is an error. |
| `SonarCloud Code Analysis` | SonarQube Cloud    | The configured new-code Quality Gate must pass.                                                                |

The exact check identities, GitHub App IDs, and coverage policy are recorded in [`config/quality-gates.json`](../config/quality-gates.json). These names are branch-protection interfaces and must not be renamed without updating the live `main` protection and the repository policy tests in the same change.

## Why the patch target is 80%

The 24 July 2026 baseline measured 90.61% server line coverage and 81.31% extension line coverage. An 80% changed-code target is therefore attainable by both executable codebases while still requiring meaningful tests for new behavior. The two-point tolerance absorbs rounding and very small patches; it is not permission to omit tests. Project coverage remains informational because Vitest already enforces repository-owned aggregate thresholds.

The umbrella patch status intentionally has no Codecov `flags` filter. Codecov can therefore annotate uncovered changed lines in GitHub while the separate `server` and `extension` flags and components retain independent histories and component statuses.

## Coverage upload and secret boundary

Trusted pushes and same-repository pull requests upload coverage and JUnit reports with the repository secret `CODECOV_TOKEN`. The secret appears only in the Ubuntu `quality (24)` job and is never passed to commands that execute untrusted fork code.

Public fork and Dependabot pull requests use Codecov's tokenless public-repository coverage upload. They upload only the two LCOV reports; authenticated Test Analytics and bundle uploads remain trusted-event only. Both paths use the repository's SHA-256-verified Codecov CLI and SHA-pinned GitHub Action.

## SonarQube Cloud ownership

SonarQube Cloud uses **GitHub App automatic analysis** for project `oaslananka_easyeda-mcp-pro`. The provider publishes `SonarCloud Code Analysis` directly on the default branch and pull requests. No repository workflow scanner and no `SONAR_TOKEN` are required, so untrusted pull requests cannot receive a Sonar credential.

Maintainers should use SonarQube for IDE Connected Mode for editor feedback. The provider-owned GitHub check remains authoritative for merge decisions.

## Failure triage

When `codecov/patch` fails:

1. Open the check details and inspect uncovered changed lines and component statuses.
2. Confirm both `server` and `extension` uploads arrived when their source trees changed.
3. Add behavior-focused tests, rerun CI, and verify the status belongs to the current head SHA.
4. Treat a missing report or provider error as a gate failure; do not bypass it by making the status informational.

When `SonarCloud Code Analysis` fails:

1. Open the provider check and inspect new issues, accepted issues, and security hotspots.
2. Fix valid findings or record a technically justified disposition in the pull request.
3. Re-run or wait for automatic analysis and verify the check belongs to the current head SHA.
4. Escalate provider outages separately; do not add a repository token-based scanner as an unreviewed fallback.

## Negative-gate verification

After policy or provider changes, maintainers create a temporary, explicitly non-mergeable **negative probe** pull request. It deliberately adds uncovered executable code and a Sonar new-code violation, records that both required checks fail and block merging, then closes the pull request and deletes the branch without merging. The probe evidence is linked from the tracking issue.
