# Local Security Tooling

This repository separates fast local feedback from networked and whole-repository security scans.
Git hooks must remain quick and deterministic; cloud and CI scanners keep the broader context.

## Check placement

| Stage        | Checks                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Editor       | SonarQube for IDE in Connected Mode                                                            |
| Pre-commit   | file hygiene, private-key detection, actionlint, and zizmor                                    |
| Pull request | CI, CodeQL, Dependency Review, repository Semgrep rules, Trivy, Snyk App, and SonarQube Cloud  |
| Release      | CycloneDX SBOM, npm provenance, GitHub artifact attestation, and SHA-pinned release automation |

Static-security workflow tooling is content-addressed rather than version-only: Semgrep runs from an
OCI image pinned to its manifest SHA-256 digest, and pre-commit is installed from
`.github/requirements/pre-commit.txt` with pip `--require-hashes`. Regenerate that lock from
`.github/requirements/pre-commit.in` with Python 3.12 and `pip-tools==7.5.3` using
`pip-compile --generate-hashes`; review both the resolved versions and hashes in the same pull
request.

GitHub secret scanning and push protection are enabled for the public repository. Validity checks,
non-provider patterns, and repository custom patterns are not available for the current user-owned
public repository; the verified state and compensating controls are documented in
[Secret Scanning and Credential Response](../SECRET_RESPONSE.md). Do not replace push protection
with a slower local full-history scanner unless a concrete gap requires it.

## Install the hook

Install `pre-commit` 4.6.0 or newer and register only the commit hook:

```bash
python3 -m pip install --user 'pre-commit>=4.6.0,<5'
pre-commit install --hook-type pre-commit
```

Validate the complete local hook set with:

```bash
pre-commit run --all-files
```

The hook set performs whitespace, YAML/JSON/TOML, merge-conflict, large-file, private-key, and
mixed-line-ending checks. `actionlint` validates GitHub Actions syntax and expressions. `zizmor`
audits workflow security at medium severity and above. Both tools are version-pinned and managed by
Renovate.

Do not add full tests, Docker builds, CodeQL, Semgrep, Snyk, or Trivy to pre-commit. Those checks
need repository, network, or CI context and would make ordinary commits unreliable.

## Semgrep commands

Repository-owned Semgrep rules remain a blocking CI check for project-specific security policy:

```bash
# Validate positive and negative rule fixtures
pnpm security:semgrep:test

# Scan the full repository with local rules
pnpm security:semgrep
```

The rules reject dynamic code execution, shell-backed child processes, and disabled TLS
certificate verification. Add focused `ruleid` and `ok` fixtures whenever a rule changes.

## Snyk authentication and scans

Snyk scans are explicit rather than Git-hook requirements. Authenticate when a maintainer needs the
commercial AppSec view or wants to reproduce the GitHub App result locally:

```bash
corepack pnpm dlx snyk@1.1306.1 auth
# Equivalent when Snyk is installed globally: snyk auth
```

Run the pinned scans with:

```bash
pnpm security:snyk:oss
pnpm security:snyk:code
pnpm security:snyk
```

Do not commit a Snyk token. A missing login or network outage must not block every local commit or
push; the remote Snyk integration remains the organization-level source of truth when enabled.

## Trivy container and configuration scans

`.github/workflows/static-security-analysis.yml` uses the SHA-pinned Trivy Action with Trivy `v0.72.0` to scan:

- Docker and repository configuration for high and critical misconfigurations,
- the production Docker image for fixed high and critical vulnerabilities.

Results are uploaded as separate SARIF categories to GitHub Code Scanning. High and critical
configuration findings, plus fixed high and critical image vulnerabilities, block the security job
after SARIF upload. Dependency Review remains the dependency-change gate; Trivy owns the distinct
Docker configuration and built-image surface.

## SonarQube Cloud Connected Mode

Install **SonarQube for IDE** in the editor and bind this workspace to the SonarQube Cloud project
`oaslananka_easyeda-mcp-pro` using **Connected Mode**. Connected Mode applies the same rules and
new-code settings used by the pull-request Quality Gate while code is being edited.

Do not add a local Sonar scanner to Git hooks. SonarQube Cloud uses GitHub App automatic analysis; the provider-owned `SonarCloud Code Analysis` check depends on branch and pull-request context and remains authoritative in GitHub. The blocking check identity and failure runbook are documented in [Changed-code quality gates](../QUALITY_GATES.md).

## CI ownership

- CodeQL provides the GitHub-native general SAST signal.
- Semgrep blocks only on repository-owned custom rules.
- Dependency Review blocks high-severity dependency changes.
- Trivy reports Docker/configuration and image findings.
- Snyk and SonarQube Cloud remain external integrations rather than duplicate local gates.
- actionlint and zizmor run both locally and in CI so workflow regressions are caught before merge.

## Dependency audit policy

Run the same dependency advisory gate used by CI and release automation:

```bash
pnpm security:audit
```

The command evaluates the complete `pnpm audit --json` result. It does not hide findings with a
blanket ignore flag. A moderate advisory may be accepted only through an exact entry in
`.github/dependency-audit-allowlist.json`; high and critical advisories always fail. Every exception
must name the affected package and resolved version, document reachability, link a tracking issue,
and include both review and expiry dates. Unexpected, changed, escalated, expired, or stale entries
fail closed.

There are currently no active dependency-audit exceptions. The former
`GHSA-frvp-7c67-39w9` exception for `@hono/node-server@1.19.14` was removed in #382 after the
workspace pinned the transitive adapter to patched `@hono/node-server@2.0.10` and the complete MCP
HTTP, Remote Relay, platform, and security verification matrix passed. The exact override remains
in `pnpm-workspace.yaml` until the production MCP SDK v1 line publishes a patched dependency range.

### Scheduled advisory monitoring

The `Dependency Advisory Monitor` workflow runs every day at **05:23 UTC** and can also be started
manually with `workflow_dispatch`. Pull requests that change the audit policy, dependency graph, or
workflow run the same job for validation.

The job first performs a frozen, script-disabled install so the committed pnpm lockfile and
workspace supply-chain policy are evaluated before any advisory decision. It then runs
`pnpm security:audit`, writes the human-readable result to the GitHub Job Summary, and uploads the
machine-readable `dependency-audit-report` JSON artifact for 14 days. The report includes advisory
IDs, affected packages, resolved dependency paths, installed versions, patched version ranges, and
policy decisions.

The workflow has read-only repository permission and never creates or updates issues. A repeated
advisory therefore produces one failed workflow signal per run without duplicate public issue
noise. Remediation remains tracked through the explicit issue referenced by a time-bounded audit
exception.
