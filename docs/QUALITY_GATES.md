# Changed-code quality gates

Pull requests use a layered changed-code quality model:

| Check / gate               | Owner                      | Merge role                                                                                                      |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `codecov/patch`            | Codecov GitHub App         | Required direct check: at least 80% patch coverage with a two-point tolerance.                                  |
| `semgrep`                  | Repository GitHub Actions  | Required direct check: project-specific security rules must pass.                                               |
| `SonarCloud Code Analysis` | SonarQube Cloud GitHub App | Advisory signal: automatic analysis remains enabled, but this provider check is not branch-protection-required. |
| Codacy                     | Codacy GitHub App          | Advisory signal; generated/package outputs are excluded by `.codacy.yml`.                                       |

The exact provider/tool identities and coverage policy are recorded in [`config/quality-gates.json`](../config/quality-gates.json). Direct required-check names are branch-protection interfaces and must not be renamed without updating the live `main` ruleset and repository policy tests in the same change.

## Why the patch target is 80%

The 24 July 2026 baseline measured 90.61% server line coverage and 81.31% extension line coverage. An 80% changed-code target is therefore attainable by both executable codebases while still requiring meaningful tests for new behavior. The two-point tolerance absorbs rounding and very small patches; it is not permission to omit tests. Project coverage remains informational because Vitest already enforces repository-owned aggregate thresholds.

The umbrella patch status intentionally has no Codecov `flags` filter. Codecov can therefore annotate uncovered changed lines in GitHub while the separate `server` and `extension` flags and components retain independent histories and component statuses.

## Coverage upload and secret boundary

Trusted pushes and same-repository pull requests upload coverage and JUnit reports with the repository secret `CODECOV_TOKEN`. The secret appears only in the Ubuntu `quality (24)` job and is never passed to commands that execute untrusted fork code.

Public fork and Dependabot pull requests use Codecov's tokenless public-repository coverage upload. They upload only the two LCOV reports; authenticated Test Analytics and bundle uploads remain trusted-event only. Both paths use the repository's SHA-256-verified Codecov CLI `11.3.1` and the Codecov Action `7.1.1` pinned to commit `303a32d7a59b442fa8d48b6a1cc6825c09c847a5`.

All Codecov uploads provide their report files explicitly, disable filesystem report discovery, and set `plugins: noop`. This intentionally skips Codecov's default Xcode, gcov, and Python-coverage preparation probes because this JavaScript/TypeScript repository uploads pre-generated LCOV/JUnit artifacts; enabling those plugins would only add non-actionable tool-discovery warnings.

## SonarQube Cloud ownership

SonarQube Cloud uses **GitHub App automatic analysis** for project `oaslananka_easyeda-mcp-pro`. Repository workflows do not invoke SonarScanner and do not consume `SONAR_TOKEN`, so fork and Dependabot pull requests never require a Sonar credential. The provider may publish `SonarCloud Code Analysis` on pull requests, but that check is **advisory**, not a branch-protection requirement.

Codecov is the coverage authority for this repository. SonarQube Cloud's JavaScript/TypeScript coverage documentation requires CI-based analysis to import LCOV, while CI-based analysis cannot run concurrently with Automatic Analysis. The repository therefore keeps Sonar automatic analysis for maintainability, reliability, security, duplication, and hotspot feedback, and keeps changed-code coverage enforcement centralized in `codecov/patch`.

Live provider state was re-verified on **2026-09-28**. On PR #599, Sonar's public API recorded the prior head with Quality Gate `ERROR` because `new_coverage` was 64.6% against an 80% condition even though the repository's Codecov patch coverage was 87.09%; on the next head, the provider check was not reported at all while all repository-owned required checks were green. Requiring that provider check would therefore make branch protection depend on a signal that automatic analysis cannot populate with the repository's LCOV data and that may not be delivered for every head.

## Failure triage

When `codecov/patch` fails:

1. Open the check details and inspect uncovered changed lines and component statuses.
2. Confirm both `server` and `extension` uploads arrived when their source trees changed.
3. Add behavior-focused tests, rerun CI, and verify the status belongs to the current head SHA.
4. Treat a missing report or provider error as a gate failure; do not bypass it by making the status informational.

When `SonarCloud Code Analysis` reports a failure:

1. Open the provider check and inspect new issues, accepted issues, and security hotspots.
2. Fix valid findings or record a technically justified disposition in the pull request.
3. Re-run or wait for automatic analysis and verify the check belongs to the current head SHA.
4. Treat provider outages or missing decoration as advisory-provider incidents; do not weaken repository-owned required checks or add a second Sonar analysis mode while Automatic Analysis is enabled.

## Negative-gate verification

After policy or provider changes, maintainers create a temporary, explicitly non-mergeable **negative probe** pull request. It deliberately adds uncovered executable code and, when relevant, a repository-owned Semgrep violation; records that the required Codecov/Semgrep gates block merging; separately confirms Sonar advisory findings are visible when the provider reports them; then closes the pull request and deletes the branch without merging.
