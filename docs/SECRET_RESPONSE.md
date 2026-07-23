# Secret Scanning and Credential Response

This runbook defines the repository's secret-scanning coverage, false-positive policy, credential-incident response, and ownership. The machine-readable evidence is [`config/secret-scanning-policy.json`](../config/secret-scanning-policy.json).

## Live GitHub settings and eligibility

The public, user-owned repository has GitHub secret scanning and push protection enabled. The 24 July 2026 verification found zero open alerts and zero resolved alerts.

GitHub validity checks and non-provider patterns are currently unavailable for this ownership and plan combination. API enable attempts were accepted but the live settings remained disabled. Repository custom patterns also returned `feature-not-available`. These are documented platform limitations, not claims that the controls are active. Re-evaluate them after an organization migration or plan change and update the policy file in the same pull request.

The gap is covered by three layers:

1. GitHub provider-pattern scanning and push protection;
2. local private-key detection in pre-commit; and
3. the deterministic `pnpm security:secrets` check over tracked files and generated server/extension outputs.

A pinned Gitleaks 8.30.1 evaluation scanned 294 commits and the generated working tree with zero findings. Synthetic redaction fixtures construct secret-like boundaries at runtime instead of committing strings that resemble credentials.

## False positives and suppressions

A scanner finding is presumed valid until reviewed. Do not silence a rule globally, exclude an entire fixture directory, or add a broad regular-expression exception.

An exception is allowed only when all of the following are recorded in the approving pull request:

- the exact scanner fingerprint or narrow file-and-rule identity;
- a technical rationale proving the value is synthetic or non-sensitive;
- the accountable owner;
- a review date; and
- an expiry date.

The current `.gitleaksignore` has no active suppressions. Expired, unexplained, or wildcard suppressions are removed rather than carried forward. A synthetic fixture should be rewritten to avoid looking like a secret whenever practical.

## Confirmed credential incident

Treat a confirmed credential as compromised even when GitHub reports it as inactive or the commit was quickly reverted.

1. **Revoke first.** Disable the credential at its provider before editing Git history, deleting an alert, or publishing incident details.
2. **Rotate every dependent credential.** Replace copies in repository secrets, environments, local `.env` files, CI systems, package registries, deployment providers, and maintainer password managers. Validate least privilege and expiry while rotating.
3. **Preserve private evidence.** Record the alert URL, first-known commit, affected services, exposure window, access logs, and revocation evidence in a private GitHub Security Advisory or equivalent restricted incident record.
4. **Contain and investigate.** Search all branches, tags, pull requests, releases, workflow logs, artifacts, package archives, container images, forks, and downstream mirrors. Review provider audit logs for unauthorized use.
5. **Repository history cleanup.** After revocation, remove the value from the current tree. Rewrite Git history only when it materially reduces further disclosure, using a coordinated maintenance window and a documented rollback point. Force-push rewritten protected refs only through the emergency governance process, notify fork owners and active contributors, expire caches/artifacts where possible, and verify the value is absent afterward.
6. **Restore safely.** Re-run secret scanning, dependency/static checks, tests, and release verification before normal publication resumes.
7. **Coordinated disclosure.** Publish a GitHub Security Advisory and release notes when users need to rotate credentials, upgrade, or take another action. Delay exploit-sensitive details only while necessary to protect users.

History cleanup never substitutes for revocation. A removed string may persist in clones, caches, logs, release assets, package registries, or third-party indexing systems.

## Alert disposition

Use GitHub's alert resolution reasons accurately. Resolve only after the credential is revoked or the finding is proven false. The resolution comment must link the private incident or false-positive evidence without copying the secret. Push-protection bypasses require the same narrow justification and follow-up review as a suppression.

## Fork and pull-request boundary

Untrusted fork code runs only in `pull_request` workflows with read-only repository permissions and without privileged repository credentials. The repository does not use `pull_request_target`. Codecov uses tokenless public-repository uploads for forks and Dependabot; authenticated analytics and release publication remain trusted-event only.

A pull request that changes workflow permissions, secret access, scanning configuration, or this runbook is critical-path work under Repository Governance.

## Ownership

The **Security contact** in [`REPOSITORY_GOVERNANCE.md`](REPOSITORY_GOVERNANCE.md) owns alert triage, provider revocation, rotation coordination, incident evidence, disclosure, and policy verification. Reports must use a private [GitHub Security Advisory](https://github.com/oaslananka/easyeda-mcp-pro/security/advisories/new), not a public issue.
