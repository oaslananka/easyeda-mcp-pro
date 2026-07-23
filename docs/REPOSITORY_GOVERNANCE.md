# Repository Governance

This document is the authoritative ownership, review, branch-protection, and emergency-maintenance policy for `easyeda-mcp-pro`. The machine-readable baseline is [`config/repository-governance.json`](../config/repository-governance.json), and `.github/CODEOWNERS` must stay consistent with it.

## Governance model

`easyeda-mcp-pro` currently uses a solo-maintainer governance model. The project owner and lead maintainer is Osman Aslan (`@oaslananka`). The lead maintainer has final decision authority for roadmap scope, issue triage, merge decisions, release timing, security response, and OpenSSF BadgeApp self-certification.

Public collaboration happens through GitHub issues, pull requests, discussions, and private GitHub Security Advisories. Changes are merged only through pull requests after the applicable automated gates and review requirements pass.

| Role             | Current holder              | Responsibilities                                                                                                              |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Lead maintainer  | Osman Aslan (`@oaslananka`) | Final project decisions, issue triage, PR merge decisions, repository settings, and governance evidence.                      |
| Release manager  | Osman Aslan (`@oaslananka`) | Release Please review, GitHub Releases, npm/GHCR publication, bridge artifacts, provenance, and rollback.                     |
| Security contact | Osman Aslan (`@oaslananka`) | Private vulnerability intake, triage, credential rotation, coordinated disclosure, advisory publication, and reporter credit. |
| Contributor      | Any GitHub contributor      | Submit focused issues and PRs, sign off non-trivial commits, add tests, and provide review evidence.                          |

## Critical-path ownership

The following paths have a higher review burden than ordinary documentation or isolated tests. `.github/CODEOWNERS` names `@oaslananka` explicitly for every listed pattern; the JSON policy test prevents those entries from silently drifting.

| Critical area                 | Covered paths                                                                                                                                        | Owner         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Security and automation       | GitHub workflows, CODEOWNERS, dependency allowlist, Renovate, Gitleaks, Semgrep, security policy, governance, security architecture, assurance case  | `@oaslananka` |
| Release                       | Release Please configuration, release channel policy, release policy/process/verification, and release CI runbook                                    | `@oaslananka` |
| Remote transport and bridge   | `src/remote`, HTTP/OAuth transports, and `src/bridge`                                                                                                | `@oaslananka` |
| Mutation and transaction code | Server transaction/write tools plus extension dispatcher, remote client, connection policy, PCB mutation/write, and schematic transaction operations | `@oaslananka` |

A change is critical-path work when it modifies one of the policy patterns, changes workflow permissions or secret access, changes authentication/authorization, changes release publication, or changes a design-mutation boundary.

## Independent human review

**Independent human review is required for critical-path changes whenever an eligible reviewer exists.** An eligible reviewer is a human other than the PR author who has repository review access and enough domain context to evaluate the affected risk. Bot approval, agent output, and the author's own self-review are not independent approval.

### Current solo-maintainer enforcement limitation

The repository currently has one write-capable maintainer. GitHub cannot require one independent approval or a code-owner approval without deadlocking every owner-authored maintenance PR. The live branch protection therefore records zero required approvals and does not yet enforce code-owner approval. This solo-maintainer enforcement limitation is public and must not be represented as independent review.

Until a second eligible maintainer is added, a critical-path PR must include:

1. a high-risk classification and rollback plan;
2. exact local and CI evidence;
3. an author self-review covering permissions, secrets, fork behavior, native mutation behavior, and release impact as applicable;
4. disposition of every bot, agent, and human finding; and
5. external review when a suitable reviewer is practically available, especially before a stable release.

When a second eligible maintainer is granted review access, the repository administrator must update branch protection and `config/repository-governance.json` in the same tracked change to require at least one approval, require code-owner review, dismiss stale approvals, and require approval after the latest push.

## Bot and agent findings

Bot and agent findings are evidence, not automatic approval. Before merge:

- resolve every actionable inline review thread;
- fix valid findings and rerun the affected checks;
- explicitly disposition false positives, accepted risks, and non-applicable suggestions with a technical rationale and evidence link;
- inspect top-level comments from SonarQube Cloud, Codecov, DeepScan, Socket, Semgrep, CodeQL, Trivy, dependency review, and any coding agent even when the check conclusion is green; and
- do not merge while a finding is unexplained, a review thread is unresolved, or a required check refers to an older head SHA.

The pull request must contain a compact disposition table when automated systems report findings. “Check passed” is not a substitute for reviewing the check's annotations or comment body.

## Main branch protection baseline

The live `main` protection and merge settings must match this table and the machine-readable policy. Branch protection is the canonical enforcement mechanism for `main`. **No repository ruleset currently overlaps** this protection; introducing a ruleset requires a separately reviewed migration that proves there is no duplicate, contradictory, or bypassing rule.

| Setting                               | Required state                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Pull request required                 | Enabled                                                                          |
| Required approvals                    | `0` only while the documented solo-maintainer limitation exists                  |
| Code-owner review                     | Disabled only while required approvals would deadlock the sole owner             |
| Dismiss stale approvals               | Disabled while approvals are zero; enable with independent review enforcement    |
| Require approval after latest push    | Disabled while approvals are zero; enable with independent review enforcement    |
| Required checks                       | `quality (24)`, `codeql`, `Socket Security: Project Report`, `dependency-review` |
| Strict/up-to-date status checks       | Enabled                                                                          |
| Conversation resolution               | Enabled                                                                          |
| Apply protection to administrators    | Enabled                                                                          |
| Linear history                        | Enabled; repository merge settings permit squash merge only                      |
| Force pushes and branch deletion      | Disabled                                                                         |
| Automatic branch deletion after merge | Enabled                                                                          |

A required-check name is a public interface. Renaming, replacing, adding, or removing one requires updating the workflow, branch protection, JSON policy, documentation, and repository-policy tests together. The setting change must be verified against the live GitHub API after merge.

## Emergency exception

An **Emergency exception** exists only for an active security incident, data-loss or unsafe-mutation risk, broken stable installation, or repository/release-system outage that prevents the normal protected-PR path. Time pressure alone is not an emergency.

Use the normal pull-request path whenever it remains technically possible. If an administrator must temporarily change or bypass a governance control, the maintainer must create a public rationale before the change or as soon as disclosure is safe. The evidence must record:

- incident and user impact;
- exact control changed or bypassed and why no safer path worked;
- author, approver or solo-maintainer limitation, and accountable owner;
- all automated gates that ran and every gate that could not run;
- known-good rollback target and restoration command or setting; and
- a follow-up review owner and deadline within **two business days**.

Restore normal protection immediately after the emergency action. Every waived review or non-automated check requires a follow-up issue. Security-sensitive details may start in a private advisory, but the eventual public record must explain the exception without exposing exploitable secrets.

Release-specific emergency publication additionally follows [`RELEASE_POLICY.md`](RELEASE_POLICY.md).

## Dependency management

Renovate is the sole automated dependency-update PR source for npm packages and GitHub Actions. Platform Dependabot alerts and security updates remain enabled for vulnerability detection.

- Patch/minor devDependency updates may auto-merge only after all required checks pass.
- Runtime dependency and major-version updates require manual maintainer review.
- npm updates observe the configured minimum release age and vulnerability prioritization.
- Lockfile maintenance runs on the documented schedule.
- Dependency exceptions require a repository-tracked allowlist entry with owner, review date, and expiry.

The detailed rationale is recorded in [`docs/adr/0002-dependency-management.md`](adr/0002-dependency-management.md).

## GitHub Actions security model

1. Actions are pinned to full 40-character commit SHAs.
2. Workflows default to `contents: read`; elevated permissions are job-scoped and justified.
3. Untrusted fork code does not receive repository secrets or privileged upload credentials.
4. Release publication uses environment/channel guards and OIDC/provenance where supported.
5. Workflow changes are critical-path changes and require the review evidence described above.

## Token governance

Repository and environment secrets must be least-privilege, narrowly scoped, and rotated when ownership or exposure changes. Never hardcode or log a credential. Release and Codecov credentials are available only to trusted repository events; fork pull requests must complete their unprivileged test path without them.

Credential incident handling is defined in [Security Policy](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/SECURITY.md), while secret-scanning configuration and false-positive policy are tracked separately.

## Issue closure and evidence

The public issue process is documented in [`ISSUE_TRIAGE.md`](ISSUE_TRIAGE.md). Roadmap issues close only when their acceptance criteria are implemented, the live settings are verified, required checks pass on the merge SHA, and a closing evidence comment links the relevant PR and settings evidence.

## Continuity

Maintainer continuity is documented in [`MAINTAINER_CONTINUITY.md`](MAINTAINER_CONTINUITY.md). The current bus factor is one and is not hidden. A backup maintainer must have enough access and documented recovery context to triage issues, merge fixes, publish emergency releases, rotate credentials, and update security advisories before the project claims a stronger bus-factor posture.

## OpenSSF evidence maintenance

OpenSSF evidence is tracked in [`OPENSSF_BEST_PRACTICES.md`](OPENSSF_BEST_PRACTICES.md). Governance, review, release, security, or continuity changes must update the relevant public evidence and policy tests in the same pull request.
