# Changed-code quality gates

Pull requests use a layered changed-code quality model:

| Check / gate               | Owner                      | Merge role                                                                     |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `codecov/patch`            | Codecov GitHub App         | Required direct check: at least 80% patch coverage with a two-point tolerance. |
| `semgrep`                  | Repository GitHub Actions  | Required direct check: project-specific security rules must pass.              |
| `SonarCloud Code Analysis` | SonarQube Cloud GitHub App | Required direct check: the configured new-code Quality Gate must pass.         |
| Codacy                     | Codacy GitHub App          | Advisory signal; generated/package outputs are excluded by `.codacy.yml`.      |

The exact provider/tool identities and coverage policy are recorded in [`config/quality-gates.json`](../config/quality-gates.json). Direct required-check names are branch-protection interfaces and must not be renamed without updating the live `main` ruleset and repository policy tests in the same change.

## Why the patch target is 80%

The 24 July 2026 baseline measured 90.61% server line coverage and 81.31% extension line coverage. An 80% changed-code target is therefore attainable by both executable codebases while still requiring meaningful tests for new behavior. The two-point tolerance absorbs rounding and very small patches; it is not permission to omit tests. Project coverage remains informational because Vitest already enforces repository-owned aggregate thresholds.

The umbrella patch status intentionally has no Codecov `flags` filter. Codecov can therefore annotate uncovered changed lines in GitHub while the separate `server` and `extension` flags and components retain independent histories and component statuses.

## Coverage upload and secret boundary

Trusted pushes and same-repository pull requests upload coverage and JUnit reports with the repository secret `CODECOV_TOKEN`. The secret appears only in the Ubuntu `quality (24)` job and is never passed to commands that execute untrusted fork code.

Public fork and Dependabot pull requests use Codecov's tokenless public-repository coverage upload. They upload only the two LCOV reports; authenticated Test Analytics and bundle uploads remain trusted-event only. Both paths use the repository's SHA-256-verified Codecov CLI `11.3.1` and the Codecov Action `7.1.1` pinned to commit `303a32d7a59b442fa8d48b6a1cc6825c09c847a5`.

## SonarQube Cloud ownership

SonarQube Cloud uses **GitHub App automatic analysis** for project `oaslananka_easyeda-mcp-pro`. The provider publishes `SonarCloud Code Analysis` directly on the default branch and pull requests. Repository workflows do not invoke SonarScanner and do not consume `SONAR_TOKEN`, so fork and Dependabot pull requests never require a Sonar credential.

Codecov is the coverage authority for this repository. SonarQube Cloud automatic analysis does not ingest the repository's JavaScript/TypeScript LCOV reports, so coverage enforcement remains centralized in `codecov/patch` rather than duplicated with conflicting thresholds.

Live provider state was re-verified on **2026-09-28**. The project uses the default **Sonar way** Quality Gate and a **previous version** new-code period. The provider check passed on PR #599 with zero annotations after repository findings were resolved.

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

After policy or provider changes, maintainers create a temporary, explicitly non-mergeable **negative probe** pull request. It deliberately adds uncovered executable code, a Sonar new-code violation, and when relevant a repository-owned Semgrep violation; records that the corresponding required gates block merging; then closes the pull request and deletes the branch without merging.
