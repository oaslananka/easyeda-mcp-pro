# Security Assurance Case

This assurance case explains why the security requirements for `easyeda-mcp-pro` are expected to be met. It is evidence for the OpenSSF Best Practices `assurance_case` criterion and should be reviewed whenever the trust model, transport model, release process, or bridge permissions change.

## Claim

`easyeda-mcp-pro` provides a safe-by-default MCP server for EasyEDA Pro workflows by applying explicit trust boundaries, secure defaults, input validation, least-privilege operational modes, dependency monitoring, and controlled release processes.

## Security requirements

The project security requirements are documented in:

- [`SECURITY.md`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/SECURITY.md)
- [`docs/security-architecture.md`](./security-architecture.md)
- [`docs/SAFETY_MODEL.md`](./SAFETY_MODEL.md)
- [`docs/vendor-terms.md`](./vendor-terms.md)

The core requirements are:

1. local-first operation is safe by default,
2. remote HTTP operation requires explicit authentication and origin controls,
3. write operations require explicit confirmation,
4. raw bridge execution is disabled by default,
5. secrets are stored outside source code and redacted from logs,
6. supplier API credentials are never committed or emitted in tool output,
7. generated artifacts are written through constrained paths,
8. releases are produced through protected CI and reviewed automation.

## Threat model summary

The main threats are documented in `docs/security-architecture.md` and include:

- credential leakage through logs or tool output,
- unauthorized bridge commands,
- unsanctioned schematic or board mutation,
- path traversal in generated artifacts,
- OAuth token forgery or replay,
- dependency supply-chain compromise,
- DNS rebinding or unsafe remote HTTP exposure,
- vendor API credential misuse.

## Trust boundaries

| Boundary                      | Trust transition                                     | Control                                                                               |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| MCP client to server          | user/AI request enters server process                | schema validation, tool profile filtering, scope checks                               |
| Server to EasyEDA bridge      | MCP tool requests become bridge protocol messages    | bridge pairing, write confirmation, documented API allowlists                         |
| Server to filesystem          | generated BOM/export/log/cache artifacts are written | path constraints, controlled data directory, explicit export tools                    |
| Server to supplier APIs       | local BOM data becomes vendor lookup requests        | opt-in credentials, redacted logs, no automatic paid ordering by default              |
| HTTP clients to MCP server    | network traffic enters remote transport              | loopback default, OAuth/JWKS support, allowed origins, rate limits                    |
| Maintainer to release channel | source changes become npm/GitHub release artifacts   | branch protection, CI quality checks, CodeQL, dependency monitoring, release workflow |

## Secure design principles applied

| Principle                   | Project application                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Fail-safe defaults          | stdio/local operation is default; raw bridge execution and paid ordering are disabled by default.  |
| Complete mediation          | MCP tools pass through schema validation, profile gating, and write-confirmation checks.           |
| Least privilege             | profiles limit exposed tools; CI permissions are scoped; supplier credentials are opt-in.          |
| Economy of mechanism        | safety gates are centralized in configuration, tool registration, and bridge manager paths.        |
| Open design                 | security architecture, safety model, and vendor terms are public documentation.                    |
| Separation of privilege     | high-risk operations require explicit feature flags and `confirmWrite` or equivalent confirmation. |
| Least common mechanism      | credentials live in environment/secrets stores, not in shared source files.                        |
| Psychological acceptability | setup, diagnostics, and errors are designed to explain safe configuration requirements.            |

## Common weakness countermeasures

| Weakness class                       | Countermeasure                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Injection / unsafe dynamic execution | no raw JavaScript execution by default; documented API allowlists; experimental flags for raw execution; the SPICE verification tools never accept a raw deck — decks are built only from typed, validated component data with identifier sanitization, since ngspice's `.control` block can otherwise run arbitrary OS commands (`docs/simulation.md`). |
| Broken authentication                | OAuth/JWKS support for remote HTTP; bridge pairing for non-loopback bridge connections.                                                                                                                                                                                                                                                                  |
| Sensitive data exposure              | log redaction, environment-based credentials, secret scanning, push protection.                                                                                                                                                                                                                                                                          |
| Path traversal                       | constrained artifact/export paths and validation around generated outputs.                                                                                                                                                                                                                                                                               |
| Vulnerable dependencies              | Dependabot alerts, Renovate, Socket, `pnpm audit`, CodeQL, lockfile review.                                                                                                                                                                                                                                                                              |
| Insecure default configuration       | non-loopback HTTP without OAuth is rejected; production config validation is strict.                                                                                                                                                                                                                                                                     |
| Insufficient tests                   | CI runs typecheck, lint, tests, coverage, evals, docs, metadata, and extension verification.                                                                                                                                                                                                                                                             |
| Unreviewed releases                  | Release Please, protected `main`, required checks, npm provenance, and release workflow gates.                                                                                                                                                                                                                                                           |

## Evidence

- Security architecture: [`docs/security-architecture.md`](./security-architecture.md)
- Safety model: [`docs/SAFETY_MODEL.md`](./SAFETY_MODEL.md)
- Vendor terms: [`docs/vendor-terms.md`](./vendor-terms.md)
- Release verification: [`docs/RELEASE_VERIFICATION.md`](./RELEASE_VERIFICATION.md)
- Supply chain verification: [`docs/supply-chain-verification.md`](./supply-chain-verification.md)
- CI workflow: [`.github/workflows/ci.yml`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/.github/workflows/ci.yml)
- Dependency automation: [`.github/dependabot.yml`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/.github/dependabot.yml), [`.github/renovate.json`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/.github/renovate.json)

## Residual risks

- Solo-maintainer continuity risk remains until a trusted backup maintainer or documented successor is added.
- Signed release tags are planned but not yet fully documented as a mandatory release gate.
- Some supplier APIs are external systems whose availability, terms, and data quality are outside project control.
- Users can intentionally enable unsafe or experimental modes; those modes must remain clearly documented and disabled by default.

## Review cadence

Review this assurance case before each minor release, after significant transport/authentication changes, and after any confirmed security incident.
