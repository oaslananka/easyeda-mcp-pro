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

## Scope

- Credential leakage via env/config exposure
- Arbitrary bridge command execution
- JLCPCB API key exposure in logs or tool output
- Unsanctioned design mutation by AI review tools
- Local file system traversal via artifact paths
- OAuth token forgery or replay

## Safe Config Enforcement

In `production` mode the server enforces:

- `BRIDGE_RAW_EXEC_ENABLED` must be `false`
- `JLCPCB_ENABLE_ORDERING` requires `JLCPCB_MODE=approved_api`
- `HTTP_HOST` bound to `127.0.0.1` unless `OAUTH_ENABLED` is `true`
- All env vars validated through a strict Zod schema at startup
