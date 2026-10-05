# Remote Runtime Boundary Instructions

These instructions apply to `src/remote/**` and supplement the repository root `AGENTS.md`.

## Boundary

This subtree implements the hosted/self-hosted remote MCP trust boundary: gateway routing, session
binding, scopes, approval state, invocation grants, protocol validation, dispatch queues, and remote
observability.

Read these before material changes:

- `docs/REMOTE_MCP_MODES.md`
- `docs/REMOTE_SECURITY_MODEL.md`
- `docs/EXTENSION_RELAY_PROTOCOL.md`
- `docs/TOOL_APPROVAL_POLICY.md`
- `docs/security-architecture.md`

Remote transport is an untrusted-network boundary. Convenience fallbacks must not weaken the local
or remote security model.

## Authentication, identity, and sessions

- Preserve authenticated identity and paired-session binding before remote tool dispatch.
- Never route a request to an arbitrary available EasyEDA session when a specific identity/session
  binding is required.
- Scope enforcement must happen before the protected operation.
- Session teardown must invalidate session-bound pending state as required by the implementation.
- Do not log bearer tokens, secrets, raw credentials, or unnecessary project payloads.

## Approval invariants

Risky remote calls fail closed unless the required approval is valid.

Approval must remain bound to:

- user identity;
- extension session;
- tool name;
- canonical input hash;
- expiration time.

An approval must not authorize a different user, session, tool, changed payload, expired request, or
replay after consumption.

Preserve the one-time consumption/revocation model for approval and invocation grants. Do not add a
fallback that silently downgrades an approval failure into a read or local-only path.

## Risk mapping

Keep runtime authorization aligned with tool metadata and `docs/TOOL_APPROVAL_POLICY.md`.

- read operations may proceed after authentication/pairing when scopes permit;
- write operations require approval;
- export operations require approval independently of local design-mutation confirmation;
- destructive operations require the stronger policy or remain disabled.

Do not infer risk from a documentation group alone.

## Protocol and failure semantics

- Validate remote protocol payloads before use.
- Preserve replay resistance, expiry checks, bounded queues/timeouts, and explicit error codes.
- Rejection, timeout, invalid scope, changed input, missing grant, expired approval, or replay must
  fail closed.
- A transport timeout during a mutation does not prove that EasyEDA state is unchanged. Surface the
  ambiguity so callers can read back before retrying.
- Protocol compatibility fields are public interfaces; follow deprecation/release policy for
  breaking changes.

## Observability

Audit enough metadata to reconstruct authorization decisions without recording secrets or raw
project data unnecessarily.

Approval/audit records should preserve the relevant identifiers and outcome while following the
repository redaction/privacy policy.

## Verification

Use focused remote/security tests while iterating, then run:

```bash
pnpm typecheck
pnpm lint
pnpm verify:fast
```

Before handoff or PR creation, run `pnpm verify`.

Changes to hosted/self-hosted behavior, auth, approval, pairing, scopes, session routing, or relay
protocol should include negative-path regression coverage. Security controls are not complete when
only the happy path passes.

## Definition of done

A remote-runtime change is complete only when authentication, identity/session binding, scopes,
approval/grant semantics, protocol behavior, negative paths, observability, and documentation remain
consistent and fail closed.
