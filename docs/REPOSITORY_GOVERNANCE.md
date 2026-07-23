# Repository Governance

This document defines ownership, critical-path review, branch protection, emergency maintenance, dependency governance, and maintainer continuity for `easyeda-mcp-pro`. The machine-readable snapshot in [`config/repository-governance-policy.json`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/config/repository-governance-policy.json) records the live enforcement posture that repository tests expect.

## 0. Governance model

`easyeda-mcp-pro` currently uses a solo-maintainer governance model. The project owner and lead maintainer is Osman Aslan (`@oaslananka`). The lead maintainer has final decision authority for roadmap scope, issue triage, merge decisions, release timing, security response, and OpenSSF BadgeApp self-certification.

The project accepts public collaboration through GitHub issues, pull requests, discussions, and private GitHub Security Advisories. Every change to `main` must use a pull request, pass protected checks, and resolve review conversations. The repository does not claim independent human review while only one eligible maintainer can approve and merge.

| Role             | Current holder              | Responsibilities                                                                                                   |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Lead maintainer  | Osman Aslan (`@oaslananka`) | Final project decisions, roadmap, issue triage, merge decisions, security response, releases, governance evidence. |
| Release manager  | Osman Aslan (`@oaslananka`) | Release policy evidence, GitHub Releases, npm, GHCR, MCP Registry, extension artifacts, rollback.                  |
| Security contact | Osman Aslan (`@oaslananka`) | Private vulnerability intake, triage, coordinated disclosure, advisory publication, reporter credit.               |
| Contributor      | Any GitHub contributor      | Submit focused issues/PRs, follow DCO expectations, add tests/docs, and respond to review findings.                |

## 1. Critical-path ownership and review

[`.github/CODEOWNERS`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/.github/CODEOWNERS) explicitly routes changes in these categories:

| Critical category                  | Representative paths                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Governance and security            | `.github/**`, `SECURITY.md`, governance/assurance/continuity evidence, audit allowlists, Renovate policy               |
| Release and supply chain           | release workflow/config/manifest, package and lockfile, `server.json`, extension manifest, release scripts, Dockerfile |
| HTTP authentication and relay      | `src/server/transports/**`, `src/remote/**`, `src/config/env.ts`, safety and redaction paths                           |
| Bridge protocol and native runtime | `src/bridge/**`, `easyeda-bridge-extension/src/**`                                                                     |
| Write and transaction paths        | `src/transactions/**`, schematic/PCB write tools, batch and transaction tools                                          |

CODEOWNERS is review routing, not proof of independence. In the current solo mode, the owner performs a documented self-review and may request an external review, but GitHub cannot require an independent human review without another eligible maintainer.

A reviewer is independent only when they did not author the change or make the most recent substantive push and have enough repository/domain access to evaluate the affected critical path. Bot, agent, scanner, and automated-review output is valuable evidence but is not an independent human approval.

### Two-maintainer activation rule

As soon as the repository has **two eligible maintainers** with permission to review and merge, the maintainer onboarding change must update CODEOWNERS and the live `main` protection in the same pull request or immediately linked administration task to:

1. require one approving review;
2. require code-owner review for matching critical paths;
3. dismiss stale approvals when new commits are pushed;
4. require approval of the most recent push by someone other than its author;
5. retain strict required checks, administrator enforcement, and conversation resolution.

From that point, a critical-path PR requires independent human review before merge. The policy must not be described as active until the eligible reviewer and live GitHub settings both exist.

## 2. Protected `main` posture

The repository currently uses classic branch protection; no repository ruleset is active. The live settings were verified on 23 July 2026 and are recorded in the machine-readable policy snapshot.

| Protection setting                       | Current solo-maintainer value                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Pull request required                    | Enabled                                                                                       |
| Required approving reviews               | 0; avoids deadlocking a repository with one eligible maintainer                               |
| Require code-owner review                | Disabled until the two-maintainer activation rule is met                                      |
| Dismiss stale approvals                  | Disabled while approvals are not required                                                     |
| Require approval of most recent push     | Disabled while approvals are not required                                                     |
| Strict status checks / up-to-date branch | Enabled                                                                                       |
| Required checks                          | `quality (24)`, `codeql`, `Socket Security: Project Report`, `dependency-review`              |
| Require conversation resolution          | Enabled                                                                                       |
| Enforce protection for administrators    | Enabled                                                                                       |
| Force pushes / branch deletion           | Disabled                                                                                      |
| GitHub `required_linear_history` flag    | Disabled                                                                                      |
| Repository merge methods                 | Squash-only; merge commits and rebase merges are disabled, producing a linear/revertable main |

Required checks are the minimum protected set. Other CI and security checks still run and must be inspected. A successful required-check summary does not permit ignoring a failed non-required security scanner, bot finding, check annotation, or unresolved review thread.

## 3. Bot and agent findings

**Bot and agent findings** must be reviewed before merge. The person merging a PR must inspect:

- human reviews and change requests;
- inline review comments and unresolved conversations;
- issue-style PR comments from bots and agents;
- check-run annotations and summaries, including Sonar, Codecov, CodeQL, Semgrep, Socket, dependency review/audit, Trivy, workflow security, and container security where present.

Every actionable finding must be fixed. A false positive, duplicate, accepted risk, or non-actionable suggestion must be **explicitly dispositioned** in the PR with the reason and supporting evidence. Silence, a green aggregate status, or an outdated bot comment is not a disposition. Required conversations remain resolved before merge, and the final inspection must use the current head SHA.

The pull request template records this review. Automated findings never replace independent human review when the two-maintainer mode is active.

## 4. Emergency exception

Emergency maintenance covers an active security incident, data-loss risk, broken stable installation, or release/infrastructure failure whose delay creates greater user risk. It is not a shortcut for normal deadlines.

In solo-maintainer mode, an emergency critical-path PR may proceed without an independent approval only because no second eligible maintainer exists. It still requires:

- a pull request rather than a direct push;
- all protected checks and conversation resolution;
- focused regression or verification evidence;
- a rollback target and named owner;
- a **public rationale** linked from the PR;
- a follow-up review within **two business days**.

For an embargoed vulnerability, details and rationale stay in a **private GitHub Security Advisory** until disclosure is safe. The public advisory, issue, release evidence, or post-incident note must be published after the fix is available and must record the exception and follow-up result.

Emergency handling does not permit silently disabling required checks, administrator enforcement, push protection, or conversation resolution. Any unavoidable temporary repository-setting change caused by a GitHub/platform outage must be narrowly scoped, restored immediately, and documented after any security embargo ends.

When two-maintainer mode is active, emergency critical-path changes still require an available independent approval. If the second maintainer is unavailable during an immediate incident, the same exception record and two-business-day retrospective apply; the exception must not become the normal merge path.

## 5. Dependency management

Renovate is the sole tool that opens routine dependency-update pull requests for npm packages and GitHub Actions. GitHub Dependabot alerts and security updates remain enabled for vulnerability detection.

- Patch/minor development-dependency updates may auto-merge only where the Renovate configuration allows and all checks pass.
- Runtime dependencies and all major updates require manual review.
- npm dependencies use a minimum release age to reduce dependency-confusion and newly published-package risk.
- The lockfile, dependency audit allowlist, Renovate configuration, package manifest, and release workflow are critical paths covered by CODEOWNERS.

Details are recorded in [`docs/adr/0002-dependency-management.md`](./adr/0002-dependency-management.md).

## 6. GitHub Actions and token governance

- Actions are pinned to full commit SHAs with version comments.
- Workflows default to least-privilege permissions; write and OIDC permissions must be justified next to the job permission.
- Workflow changes are critical-path changes and run actionlint, zizmor, workflow-security, and the normal CI/security matrix.
- Secrets remain in GitHub Actions secrets or approved external secret stores and must not be logged.
- `NPM_TOKEN` is publish-only. Release OIDC/provenance and MCP Registry permissions follow the [Release Policy](RELEASE_POLICY.md).
- The release workflow currently uses `GITHUB_TOKEN`. Introducing a PAT or GitHub App token requires a separate critical-path review and documentation of scope, rotation, and revocation.

## 7. Administration and drift review

Repository administrators review live settings against `config/repository-governance-policy.json`:

- after adding or removing a maintainer;
- after changing CODEOWNERS, workflows, required checks, merge methods, or security features;
- before each major release;
- after any emergency exception or confirmed security incident;
- at least every six months.

The current baseline requires protected pull requests, strict status checks, conversation resolution, administrator enforcement, no force pushes/deletions, squash-only merges, Dependabot alerts/security updates, secret scanning, and push protection. If GitHub settings drift, correct the live setting or update the public policy and evidence in a reviewed PR; do not leave contradictory claims.

## 8. Issue triage, continuity, and OpenSSF evidence

The public issue process is documented in [`docs/ISSUE_TRIAGE.md`](./ISSUE_TRIAGE.md). Roadmap issues close only after acceptance criteria are implemented, verified, and linked in a public completion comment.

Maintainer continuity is documented in [`docs/MAINTAINER_CONTINUITY.md`](./MAINTAINER_CONTINUITY.md). The bus factor remains one until a trusted backup maintainer has the access and knowledge to triage, review, merge, publish emergency releases, rotate credentials, and update security advisories.

OpenSSF evidence is tracked in [`docs/OPENSSF_BEST_PRACTICES.md`](./OPENSSF_BEST_PRACTICES.md). Governance claims must describe the live repository, especially the difference between CODEOWNERS routing and enforced independent approval.
