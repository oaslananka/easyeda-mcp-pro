# Maintainer Continuity

This document records the continuity plan for `easyeda-mcp-pro`. It is intentionally simple because the project is currently operated as a solo-maintainer public open source project.

## Current governance shape

- **Lead maintainer and project owner:** Osman Aslan (`@oaslananka`).
- **Decision model:** single-maintainer / benevolent-maintainer model. The lead maintainer has final decision authority for roadmap, release timing, security response, and merge decisions.
- **Public collaboration surfaces:** GitHub issues, pull requests, discussions, security advisories, and release notes.

## Continuity objectives

If the current maintainer becomes unavailable, the project should still be able to:

1. triage or close issues,
2. review and merge pull requests,
3. publish or transfer releases,
4. rotate or revoke credentials,
5. update the project documentation and security policy,
6. transfer stewardship if needed.

## Required access inventory

The maintainer should keep an offline, encrypted continuity record that identifies how a trusted successor can recover or transfer the following assets:

| Asset                             | Purpose                                                     | Continuity action                                                                                         |
| --------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GitHub repository ownership/admin | Issues, PRs, releases, branch protection, security features | Store recovery instructions and successor contact information in an offline vault or legal/estate record. |
| npm package ownership             | Package publishing and deprecation notices                  | Ensure npm account recovery and package transfer instructions exist.                                      |
| GitHub Actions secrets            | Release automation and npm publishing                       | Document secret names, purpose, and rotation steps. Do not store plaintext secrets in the repo.           |
| OpenSSF BadgeApp project          | Badge evidence and self-certification status                | Document BadgeApp project ID `13406` and owner transfer path.                                             |
| Domain/docs hosting, if any       | Documentation availability                                  | Document hosting and DNS ownership if moved away from GitHub Pages.                                       |

## Successor requirements

A successor maintainer should be able to:

- access the repository with admin rights,
- rotate npm and GitHub Actions credentials,
- review the latest `SECURITY.md`, `docs/RELEASE_PROCESS.md`, and `docs/RELEASE_VERIFICATION.md`,
- publish an emergency release or deprecation notice,
- update OpenSSF evidence if the governance model changes.

## Solo-maintainer bus-factor statement

The current bus factor is one and **no successor is currently designated**. This is acceptable for the
current project phase only with an explicit continuity plan; it is not evidence of independent review
or operational redundancy. The project must not claim a stronger bus-factor posture until a named,
consenting human has the access and verified evidence below.

## Backup maintainer qualification

A backup maintainer or successor must be a real human who has agreed to the role and can demonstrate:

- GitHub `maintain` or administrator access and private security-advisory access;
- an npm recovery or package-transfer path without sharing plaintext credentials;
- understanding of the release, rollback, secret-rotation, and vulnerability-disclosure runbooks;
- ability to restore branch protection and revoke compromised credentials; and
- one recorded emergency-release dry run using a non-production version or documented simulation.

Granting access alone is insufficient. Record the individual's consent, access verification date,
reviewed runbooks, dry-run evidence, and revocation procedure in the encrypted continuity record.
Public documentation may identify the role without exposing recovery secrets.

## Activation of independent review

Once a second eligible maintainer has accepted review responsibility, follow the activation runbook
in [`REPOSITORY_GOVERNANCE.md`](REPOSITORY_GOVERNANCE.md) within two business days. Until that live
change and its test pull request are verified, branch protection remains accurately documented as
zero required approvals because enforcing one approval against a sole owner would deadlock maintenance.

## Review cadence

Review this document at least every six months and whenever package ownership, GitHub ownership, release credentials, or the OpenSSF BadgeApp owner changes.
