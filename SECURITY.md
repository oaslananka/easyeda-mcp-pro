# Security Policy

## Supported Versions

Only the latest active release branch is officially supported for security updates.

| Version                   | Supported          |
| ------------------------- | ------------------ |
| Latest npm/GitHub release | :white_check_mark: |
| Older releases            | Best-effort only   |

## Reporting a Vulnerability

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/oaslananka/easyeda-mcp-pro/security/advisories/new).

**Do not disclose security-relevant issues publicly.** We aim to acknowledge reports within 48 hours and release a fix within 7 days of triage confirmation.

Critical-path ownership, protected review, emergency exceptions, and the embargo-safe public follow-up requirement are defined in [Repository Governance](docs/REPOSITORY_GOVERNANCE.md).

## Scope

- Credential leakage via env/config exposure
- Arbitrary bridge command execution
- JLCPCB API key exposure in logs or tool output
- Unsanctioned design mutation by AI review tools
- Local file system traversal via artifact paths
- OAuth token forgery or replay

## Safe Config Enforcement

At startup the server enforces:

- non-loopback `BRIDGE_HOST` requires a non-empty `BRIDGE_TOKEN` for pairing
- every non-loopback HTTP listener requires OAuth/JWKS authentication regardless of `NODE_ENV`
- non-loopback HTTP requires an explicit origin allowlist and rejects `ALLOWED_ORIGINS=*`
- all environment variables are validated through a strict Zod schema

In `production` mode the server additionally enforces:

- `BRIDGE_RAW_EXEC_ENABLED` must be `false`
- `JLCPCB_ENABLE_ORDERING` requires `JLCPCB_MODE=approved_api`

## Response Process

The maintainer follows this process for private vulnerability reports:

1. **Acknowledge** the report within 48 hours when possible.
2. **Triage** severity, affected versions, exploitability, and whether the report is inside project scope.
3. **Coordinate privately** with the reporter through GitHub Security Advisories or another agreed private channel.
4. **Develop and test** a fix on a private branch or advisory fork when appropriate.
5. **Release** the fix through the normal protected release workflow or an emergency patch workflow.
6. **Publish** advisory details after a fixed version is available, unless disclosure would create unnecessary user risk.
7. **Credit** the reporter unless they request anonymity.

Target timelines:

| Severity | Target fix or mitigation window after triage confirmation |
| -------- | --------------------------------------------------------- |
| Critical | 7 days                                                    |
| High     | 14 days                                                   |
| Medium   | 30 days                                                   |
| Low      | Next normal release where practical                       |

These are targets, not guarantees. Coordinated disclosure may require a different schedule.

## Reporter Credit

Resolved vulnerability reports should credit the reporter in the GitHub Security Advisory, release notes, or changelog unless the reporter requests anonymity or credit would increase risk.

If no vulnerabilities were resolved in the last 12 months, the OpenSSF `vulnerability_report_credit` criterion should be marked as not applicable with this policy as evidence.

## Security Requirements

The software is intended to meet the following security requirements:

- safe local operation by default,
- no raw bridge execution by default,
- explicit confirmation for design-changing operations,
- no automatic paid supplier ordering without approved API mode and explicit user confirmation,
- strict configuration validation at startup,
- secrets in environment variables or secret stores rather than committed files,
- log redaction for credentials and tokens,
- OAuth/JWKS validation for remote HTTP deployments,
- loopback-only defaults for local services,
- generated artifacts constrained to configured output locations,
- dependency and static-analysis monitoring in CI.

Additional evidence is documented in [`docs/security-architecture.md`](docs/security-architecture.md), [`docs/SAFETY_MODEL.md`](docs/SAFETY_MODEL.md), and [`docs/SECURITY_ASSURANCE_CASE.md`](docs/SECURITY_ASSURANCE_CASE.md).
