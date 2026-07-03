# Repository Governance

This document outlines the governance model, security standards, branch protection rules, and dependency management policies for the `easyeda-mcp-pro` repository.

---

## 0. Governance Model

`easyeda-mcp-pro` currently uses a solo-maintainer governance model. The project owner and lead maintainer is Osman Aslan (`@oaslananka`). The lead maintainer has final decision authority for roadmap scope, issue triage, merge decisions, release timing, security response, and OpenSSF BadgeApp self-certification.

The project accepts public collaboration through GitHub issues, pull requests, discussions, and private GitHub Security Advisories. When external contributors submit changes, the maintainer reviews the change, requires CI to pass, and may request revisions before merge.

High-risk changes should receive extra review where practical, even though the repository does not currently require a second approver. High-risk changes include authentication, bridge command execution, supplier API credentials, release automation, dependency security policy, and GitHub Actions permissions.

## Roles and Responsibilities

| Role             | Current holder              | Responsibilities                                                                                                            |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Lead maintainer  | Osman Aslan (`@oaslananka`) | Final project decisions, roadmap, issue triage, PR merge decisions, security response, releases, OpenSSF BadgeApp evidence. |
| Release manager  | Osman Aslan (`@oaslananka`) | Release Please review, GitHub Releases, npm publishing, bridge extension artifacts, release verification.                   |
| Security contact | Osman Aslan (`@oaslananka`) | Private vulnerability intake, triage, coordinated disclosure, advisory publication, reporter credit.                        |
| Contributor      | Any GitHub contributor      | Submit issues/PRs, follow DCO/sign-off expectations, add tests/docs for changes.                                            |

If another active maintainer is added, this table should be updated and branch protection should be revisited to require at least one independent approval for high-risk changes.

---

## 1. Branch Protection Policy (main branch)

To enforce code quality, security, and a clean history, the `main` branch must have the following protection rules configured in GitHub (**Settings > Branches > Add rule**):

| Rule Setting                                     | Status                               | Rationale                                                                                                                                    |
| :----------------------------------------------- | :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| **Require a pull request before merging**        | **Enabled**                          | Prevents direct pushes to the production branch.                                                                                             |
| **Require approvals**                            | **Disabled for solo maintainer**     | Required reviews are not enforced while the repository has a single maintainer; required checks and conversation resolution remain enforced. |
| **Dismiss stale pull request approvals...**      | **N/A while approvals are disabled** | Re-enable if the repository adds another active maintainer and mandatory reviews return.                                                     |
| **Require status checks to pass before merging** | **Enabled**                          | Enforces automated quality checks.                                                                                                           |
| _Status Check:_ `quality (24)`                   | **Required**                         | Ensures the codebase builds, lints, tests, audits, and verifies docs on Node 24.                                                             |
| _Status Check:_ `codeql`                         | **Required**                         | Ensures static application security analysis (SAST) passes.                                                                                  |
| **Require branches to be up to date...**         | **Enabled**                          | Enforces strict branch testing against the latest `main` commit.                                                                             |
| **Require conversation resolution...**           | **Enabled**                          | Ensures all review comments are addressed.                                                                                                   |
| **Require linear history**                       | **Optional**                         | Use only if maintainers prefer squash/rebase merges. Current repo history uses merge commits for PR traceability.                            |
| **Do not allow force pushes**                    | **Enforced**                         | Prevents history rewriting on `main`.                                                                                                        |
| **Do not allow deletions**                       | **Enforced**                         | Prevents accidental deletion of the `main` branch.                                                                                           |

---

## 2. Dependency Management Policy (Renovate)

We use **Renovate** to keep our software supply chain up to date while mitigating security risks. Renovate is the sole tool that opens automated dependency-update pull requests, for both npm packages and GitHub Actions; no `.github/dependabot.yml` version-update config is maintained, so that two bots cannot propose conflicting updates for the same dependency. GitHub's platform-level Dependabot alerts and Dependabot security updates (vulnerability detection, not update PRs) remain enabled separately — see the checklist in section 5. Details and rationale are recorded in [`docs/adr/0002-dependency-management.md`](./adr/0002-dependency-management.md).

### Automerge Rules

- **Patch/Minor devDependencies**: Automatically merged if CI passes. This covers development utilities (e.g., eslint, prettier, tsx) that do not affect the production runtime.
- **Runtime Dependencies**: Never auto-merged. All upgrades for core runtime packages (e.g., `@modelcontextprotocol/sdk`, `zod`, `jose`, `ws`, `undici`) must be manually reviewed and tested.
- **Major Updates**: Never auto-merged. Major updates require approval on the Renovate **Dependency Dashboard** or manual PR review.

### Security Controls

- **Minimum Release Age**: NPM dependencies must be released for at least **3 days** before Renovate creates a PR, preventing zero-day dependency poisoning.
- **Vulnerability Alerts**: Renovate is configured with `osvVulnerabilityAlerts: true` to prioritize patching known CVEs.
- **Weekly Maintenance**: Lockfile maintenance runs weekly (Mondays before 5 AM) to keep sub-dependencies clean and deduplicated.

---

## 3. GitHub Actions Security Model

To prevent token leakage and unauthorized workflows:

1. **SHA Pinning**: All GitHub Actions references must be pinned to full 40-character commit SHAs (e.g., `actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10`), with a tag version comment next to them.
2. **Least Privilege**: Workflows default to `permissions: contents: read`. Only the release workflow has elevated permissions (`contents: write`, `pull-requests: write`, `issues: write`, `id-token: write`), which are restricted to the specific jobs that need them.
3. **Concurrency**: All workflows define `concurrency` to cancel in-progress runs on the same branch/tag, optimizing resource usage.

---

## 4. Token Governance

- **NPM Token**: A repository secret named `NPM_TOKEN` (granularity: publish-only) must be configured to allow automated publishing.
- **Release Please PR Triggering**:
  By default, when `GITHUB_TOKEN` is used, GitHub Actions will _not_ trigger workflows on pull requests created by Release Please. If you want CI/CD checks to run on Release Please PRs, you must:
  1. Generate a **Fine-grained Personal Access Token (PAT)** with:
     - Repository access: `easyeda-mcp-pro` only
     - Permissions: `contents: write`, `pull-requests: write`
  2. Save this token as a repository secret named `RELEASE_PLEASE_TOKEN`.
  3. Update `release-please.yml` to use <code v-pre>token: ${{ secrets.RELEASE_PLEASE_TOKEN }}</code>.

  _Never hardcode or log any tokens in files or script outputs._

---

## 5. Maintainer Setup Checklist

Repository administrators should go through the following settings checklist to align the live repository with this governance document:

- [ ] **Configure Branch Protection**: Go to **Settings > Branches** and add a protection rule for `main` enforcing:
  - Require a pull request before merging.
  - Do not require approval while the repository is in solo-maintainer mode.
  - Re-enable stale-review dismissal when required reviews are restored.
  - Require status checks to pass before merging (`quality (24)`, `codeql`, Socket/DeepScan checks where enabled).
  - Require branches to be up to date before merging.
  - Require conversation resolution before merging.
  - Require linear history.
  - Do not allow force pushes or deletions.
- [ ] **Enable Security Features**: Go to **Settings > Security & analysis** and enable:
  - Dependency graph.
  - Dependabot alerts.
  - Dependabot security updates.
  - Secret scanning.
  - Push protection (to prevent committing secrets).
- [ ] **Configure NPM Credentials**: Go to **Settings > Secrets and variables > Actions** and add `NPM_TOKEN` under Repository Secrets.
- [ ] **Configure Release Please Token** (Optional): If running CI checks on Release Please PRs is required, add `RELEASE_PLEASE_TOKEN` (fine-grained PAT) to Repository Secrets.
- [ ] **Enable GitHub Discussions** (Optional): Enable under General settings to provide community support.

---

## 6. Issue Triage and Label Taxonomy

The public issue process is documented in [`docs/ISSUE_TRIAGE.md`](./ISSUE_TRIAGE.md). New issues should include:

- affected area (`area:*`)
- priority (`priority:P0` through `priority:P2`)
- risk class when relevant (`risk:*`)
- expected behavior and acceptance criteria
- reproduction or validation evidence

Roadmap issues must not be closed only because related documentation exists. Close them only when the acceptance criteria have been implemented, verified, and linked in the closing comment.

---

## 7. Continuity and Bus Factor

Maintainer continuity is documented in [`docs/MAINTAINER_CONTINUITY.md`](./MAINTAINER_CONTINUITY.md). The project is currently a solo-maintainer project, so the bus factor is one. That risk is explicitly documented rather than hidden.

Before claiming a stronger OpenSSF bus-factor posture, the project should add at least one trusted backup maintainer or successor path with enough access to triage issues, merge fixes, publish emergency releases, rotate credentials, and update security advisories.

---

## 8. OpenSSF Evidence Maintenance

OpenSSF evidence is tracked in [`docs/OPENSSF_BEST_PRACTICES.md`](./OPENSSF_BEST_PRACTICES.md). BadgeApp answers must not be marked as `Met` unless the linked evidence accurately describes the live repository.

When governance, release, security, or continuity processes change, update this document and the OpenSSF evidence map in the same pull request.
