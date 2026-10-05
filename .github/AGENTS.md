# CI and Release Automation Instructions

These instructions apply to `.github/**` and supplement the repository root `AGENTS.md`.

## Boundary

Workflow and repository-control changes are policy changes. They can affect branch protection,
security posture, dependency trust, release identity, provenance, registries, and public artifacts.

Read these before material changes:

- `docs/REPOSITORY_GOVERNANCE.md`
- `docs/RELEASE_POLICY.md`
- `docs/RELEASE_PROCESS.md`
- `docs/RELEASE_VERIFICATION.md`
- `docs/release-ci-runbook.md`
- `docs/security-architecture.md`

## Required-check integrity

Required status names are repository interfaces.

- Keep the protected `quality (24)` context stable unless branch protection is intentionally
  migrated and verified in the same change.
- Before renaming, deleting, or path-filtering an entire required workflow/job, verify how the live
  `main` ruleset resolves the check.
- Avoid configurations that leave branch protection waiting forever for a required context that no
  longer runs.
- Do not use `continue-on-error`, exclusions, or trigger narrowing to conceal a repository-owned
  test, audit, packaging, security, or release failure.

External telemetry is different from repository-owned validation. The current policy keeps local
Vitest coverage thresholds and report validation merge-critical while Codecov upload telemetry is
non-blocking. Do not reverse that policy accidentally through workflow refactoring.

## Permissions and untrusted input

- Use least-privilege `permissions` at workflow and job scope.
- Keep checkout credentials disabled unless a reviewed mutation requires them.
- Do not expose secrets to untrusted fork code or interpolate untrusted event data into shell
  commands without a safe boundary.
- Preserve separation between untrusted validation and privileged publication.
- Keep GitHub Actions SHA-pinned; do not replace immutable pins with floating tags for convenience.

## Security and dependency automation

Do not weaken:

- CodeQL/Semgrep/static analysis;
- Dependency Review and repository dependency-audit policy;
- secret scanning/hygiene;
- workflow security checks;
- container/image security where configured;
- runtime/dependency pin parity.

An external scanner outage is not evidence that repository security policy should be bypassed.
Record the external failure separately from repository-owned gate results.

## Release and publication

Release workflows are privileged supply-chain code.

Preserve:

- exact source/tag/channel identity;
- stable vs prerelease channel separation;
- immutable version/tag expectations;
- npm provenance/trusted publication requirements;
- SBOM generation and retention;
- GitHub attestation/provenance evidence;
- extension artifact identity;
- GHCR exact/channel tag semantics;
- stable MCP Registry promotion rules;
- post-publication verification and recovery semantics.

Do not replay a previously successful publication mutation merely to repeat verification. Follow the
documented recovery path.

Do not repoint immutable release tags, silently replace released assets, or publish from an
unverified source revision.

## Workflow maintenance

When workflow behavior changes:

- update the corresponding policy/runbook documentation and repository-policy tests when required;
- preserve stable artifact names/evidence contracts consumed by downstream jobs or release tooling;
- keep scheduled/advisory automation distinct from genuinely merge-critical validation;
- prefer reusable workflow/composite-action boundaries only when they clarify ownership rather than
  hiding critical execution flow.

## Validation

For workflow changes, run the repository's local hook/security tooling applicable to GitHub Actions,
then at minimum:

```bash
pnpm format:check
pnpm verify:fast
```

Before handoff or PR creation, run `pnpm verify`.

A YAML parser passing is not enough. Validate GitHub Actions semantics, permissions, required-check
behavior, and any release/security contract affected by the change.

## Definition of done

A CI/release change is complete only when workflow syntax, security linting, required-check behavior,
permissions, evidence/artifact contracts, release identity, and documentation agree.
