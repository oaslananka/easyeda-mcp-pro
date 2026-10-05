# Changed-code quality gates

Pull requests use a layered quality model that separates repository-owned merge gates from external analytics:

| Check / gate                      | Owner                      | Merge role                                                                                                                                                         |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality (24)`                    | Repository GitHub Actions  | **Required aggregator** over deterministic static quality, local tests/coverage, extension integrity, package/docs/Docker validation, and the supported-OS matrix. |
| `codeql`                          | Repository GitHub Actions  | Required direct security check.                                                                                                                                    |
| `semgrep`                         | Repository GitHub Actions  | Required direct project-specific security check.                                                                                                                   |
| `Socket Security: Project Report` | Socket GitHub App          | Required dependency-risk check.                                                                                                                                    |
| `dependency-review`               | Repository GitHub Actions  | Required dependency-diff check.                                                                                                                                    |
| `codecov/patch`                   | Codecov GitHub App         | Advisory changed-line coverage telemetry. The configured 80% target remains useful, but this provider status is not branch-protection-required.                    |
| `SonarCloud Code Analysis`        | SonarQube Cloud GitHub App | Advisory maintainability/security signal.                                                                                                                          |
| Codacy                            | Codacy GitHub App          | Advisory signal; generated/package outputs are excluded by `.codacy.yml`.                                                                                          |

The exact live branch-protection interface is recorded in `config/repository-governance.json` and the latest ruleset evidence snapshot. Required-check names are public interfaces and must not be renamed without updating the live ruleset and repository policy in the same change.

## Blocking coverage authority

Local Vitest coverage is the blocking coverage authority. The `tests-and-coverage` job generates server and extension LCOV/JUnit outputs, applies repository-owned thresholds, and validates both report sets. That job feeds the required `quality (24)` aggregator.

Codecov remains valuable for changed-line annotations, component histories, and Test Analytics, but provider availability must not decide whether repository-owned tests passed. `codecov.yml` therefore retains the 80% patch target and two-point tolerance as advisory provider policy while branch protection relies on local coverage enforcement.

## Coverage telemetry and secret boundary

The `coverage-telemetry` job runs only after the required local tests/coverage job succeeds. Its artifact transfer, Codecov configuration validation, CLI installation, and provider uploads are diagnostic/non-blocking and are not dependencies of `quality (24)`.

Trusted pushes and same-repository pull requests may use the repository secret `CODECOV_TOKEN` only inside `coverage-telemetry`. Public fork and Dependabot pull requests use the tokenless public-repository coverage path. The repository uses the SHA-256-verified Codecov CLI and a full-SHA-pinned Codecov Action.

All Codecov uploads provide report files explicitly, disable filesystem report discovery, and use `plugins: noop`.

## SonarQube Cloud ownership

SonarQube Cloud uses **GitHub App automatic analysis** for project `oaslananka_easyeda-mcp-pro`. Repository workflows do not invoke SonarScanner or consume `SONAR_TOKEN`. `SonarCloud Code Analysis` is advisory.

Local Vitest CI is the blocking coverage authority; Sonar and Codecov are complementary provider-owned analytics surfaces.

## Failure triage

When `quality (24)` fails:

1. Open its summary and identify which deterministic dependency failed: `static-quality`, `tests-and-coverage`, `extension-integrity`, `package-docs-docker`, or `test-matrix`.
2. Fix that repository-owned failure rather than rerunning unrelated stages blindly.
3. Verify the corrected check belongs to the current head SHA.
4. Do not weaken thresholds or remove a deterministic dependency merely to make the aggregator green.

When `codecov/patch` or `coverage-telemetry` fails:

1. Confirm `tests-and-coverage` passed locally enforced thresholds and report validation.
2. Inspect Codecov configuration, TLS/service health, artifact transfer, and upload diagnostics.
3. Fix repository-side telemetry defects when present, but treat provider outages as external incidents.
4. Do not disable TLS verification or weaken local coverage policy to compensate for a provider failure.

When `SonarCloud Code Analysis` reports a failure, inspect and disposition valid findings, but do not add a second Sonar analysis mode or make provider availability part of the deterministic quality aggregator.

## Negative-gate verification

After quality-policy changes, use a temporary non-mergeable negative probe when practical. It should demonstrate that repository-owned local coverage thresholds and Semgrep findings block the required quality/security path. Provider-owned Codecov and Sonar signals should be verified separately as advisory visibility, then the probe branch should be closed/deleted without merge.
