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

## Codecov patch required-check qualification (#786)

The Codecov patch target is configured to reject under-covered changed source, but
that setting alone does not make Codecov a required GitHub merge check. PR #784
exposed this gap: its patch check failed while the existing deterministic gates
passed and the PR was merged. Follow-up PR #785 fixed the patch coverage and
passed Codecov; the protected ruleset did not change.

Before intentionally changing the documented _advisory telemetry_ policy,
the maintainers must verify the same stable Codecov check for:

- a documentation-only pull request with **no coverable source changes**;
- a pull request with new uncovered source lines where repository-wide Vitest
  coverage thresholds still pass; and
- both server-only and extension-only source changes.

Only a check consistently reported for all applicable PRs can be safely added
to the GitHub required-check set. A missing required status would block all
merges, including unrelated documentation and release maintenance. Do not
change, bypass, or replace existing protection controls during qualification.
Document the observed check identity, provider, SHA, outcome, and the rollback
before any separately reviewed ruleset update.

## Qualification results and reviewed activation plan (#786)

The documentation-only #787 final PR head `6961af2` reported successful
`codecov/patch` and passed all required checks before merging. On its temporary
`76b2ad8` negative-test head, an uncovered new source function caused
`codecov/patch` and `codecov/patch/MCP Server` to fail even though the
local overall Vitest coverage thresholds passed. The temporary source file
was removed; it was **not merged**. Previously observed Dependabot #733
and Renovate #749/#769 also reported the umbrella `codecov/patch` status.

A proposed future rule is recorded in the governance and quality-gate JSON
files. It is **not active** merely because these files or this text exist.
After an independently reviewable settings change, the desired main-standard
ruleset would add **only** `codecov/patch` from the Codecov GitHub App
(integration ID `254`) to its existing five required status checks,
retaining strict up-to-date checking, squash-only PRs, thread resolution,
and every other current rule. Component-specific patch checks are _not_
proposed as required because they may not represent every PR type.

Before activating the live rule:

1. Check the exact ruleset ID (`20020112`), unchanged current check set,
   current actor permissions and Codecov check app identity via GitHub API.
2. Confirm that a docs-only check still appears as success and that
   an uncovered-source check fails, including fork/Dependabot behavior.
3. Apply a **separately reviewed** ruleset edit that adds only the Codecov
   umbrella patch check, without using owner bypass; reread and compare
   the entire live ruleset to the recorded before-state.
4. Verify GitHub actually blocks a failing patch on a disposable non-mergeable
   PR and allows a docs-only PR with a reported successful patch. Never
   merge the negative probe.
5. Record the new verified live snapshot, update the operative policy and
   tests to say Codecov is required, and close #786 only after acceptance.

**Trade-off:** a missing Codecov status or Codecov outage can block merges.
`coverage-telemetry` stays diagnostic; never spoof statuses, relax CI, turn
off TLS verification, or use owner/admin bypass for a provider outage.
If the rule unexpectedly deadlocks otherwise valid PRs, revert **only**
the added `codecov/patch` requirement through the audited settings-change
process, reverify the original five checks, and retain the incident evidence.
The current advisory policy remains authoritative until that migration
is completed and independently verified.

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
