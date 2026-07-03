# Remote release readiness checklist

This document records the minimum evidence needed before remote MCP support is described as beta-ready.

## Status language

| Term | Meaning |
| --- | --- |
| Planned | Design exists, but users cannot call it yet. |
| Experimental | Code exists behind explicit flags. |
| Beta | Users can test it with documented limits. |
| Production-ready | CI, live validation, security review, and runbooks are complete. |

## Gateway release gate

A release candidate should verify:

- HTTP transport is intentional for remote mode.
- A canonical public base URL is configured.
- Public endpoints use TLS except loopback-only development URLs.
- User authentication is enabled for remote endpoints.
- Extension pairing is required before remote tool routing.
- Read calls fail safely when no paired active project is available.
- Write and export calls require explicit user approval before dispatch.
- Origin allowlist, rate limits, and redacted logs are configured.

## Fake extension integration evidence

CI-safe integration tests should run without live EasyEDA credentials and prove:

- Session registration and heartbeat work.
- Pairing rejects expired, reused, and wrong-user codes.
- Remote read requests route only to the paired session.
- Write and export requests wait for approval before dispatch.
- Rejection, timeout, mismatched input hash, and disconnect cases fail closed.
- User A cannot route a request to user B's session.

## Live EasyEDA compatibility evidence

Before claiming support for a new EasyEDA Pro runtime version:

- Capture a runtime inventory snapshot from a disposable project.
- Record EasyEDA Pro version, bridge version, snapshot path, and method registry hash.
- Diff the snapshot against the previous compatible baseline.
- Review removed or renamed runtime methods before release.
- Run live smoke tests against a disposable project.
- Link the diff and smoke report from release notes or release verification docs.

## Release evidence

Release verification should confirm:

- Package and metadata versions are aligned.
- Release artifact checksums are published.
- SBOM and provenance evidence are attached where supported.
- Registry metadata validation or dry-run result is recorded before remote metadata is advertised.
- OpenSSF and Scorecard evidence reflects live repository state.
- Signed tag or signed release policy is implemented or tracked with a concrete blocker.
