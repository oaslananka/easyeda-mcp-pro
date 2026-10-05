# MCP Tool Boundary Instructions

These instructions apply to `src/tools/**` and supplement the repository root `AGENTS.md`.

## Boundary

This subtree defines the MCP server's executable tool contract. Tool metadata is not decorative
documentation: it participates in authorization, approval, remote routing, capability exposure, and
client-visible schemas.

Read these before material changes:

- `docs/SAFETY_MODEL.md`
- `docs/TOOL_APPROVAL_POLICY.md`
- `docs/security-architecture.md`
- `src/tools/registry.ts`
- `src/tools/types.ts`
- `src/tools/transaction.ts`

## Security-sensitive metadata

Treat changes to any of these fields as security/behavior changes:

- `risk`
- `sideEffect`
- `confirmWrite`
- `confirmationPolicy`
- tool profile
- required scopes
- input/output schemas
- evidence metadata
- MCP annotations

A tool's documentation group or filename is not an authorization decision.

Preserve the explicit side-effect model:

- `read-only` remains non-mutating;
- `artifact-write` creates artifacts but does not silently become a design mutation;
- `design-mutation` and `local-state-write` remain protected writes;
- `external-action` remains an externally consequential operation.

Remote relay risk derives from this metadata. Do not relabel a tool to avoid approval or simplify a
client flow.

## Confirmation and approval

Local design mutation and remote approval are separate controls.

- Tools that require `confirmWrite` must continue to reject apply/mutation requests without the
  explicit acknowledgment required by their policy.
- Remote `write`, `export`, and `destructive` operations must still pass the remote gateway
  authorization/approval boundary.
- Do not treat local `confirmWrite=true` as a substitute for remote approval.
- Do not make artifact export silently bypass remote export approval merely because it does not
  mutate the EasyEDA design.

Where preview/apply behavior exists, preserve deterministic preview semantics and do not introduce a
hidden mutation during planning.

## Validation and schemas

- Parse untrusted tool input through the declared Zod schema before domain execution.
- Preserve explicit output schemas and structured tool errors.
- Do not return a successful MCP result that fails the declared output contract.
- Keep transport controls such as remote session/approval state separate from domain input semantics.
- Validate identifiers, paths, numeric bounds, and runtime capability assumptions before mutation
  when possible.

Expected invalid input should fail explicitly and predictably. Avoid permissive fallback that turns a
schema or capability failure into a best-effort write.

## Mutation, transactions, and read-back

- Preflight all deterministic conditions that can be checked before the first write.
- Preserve transaction/rollback behavior where the protocol supports it.
- If rollback is partial or impossible, report the unresolved state explicitly.
- A timeout or disconnect during a live mutation is an ambiguous outcome, not proof of failure.
  Read back project state before retrying.
- Never add blind automatic retries around non-idempotent mutation.
- When a tool claims a persisted change, require the established post-write read-back/evidence path
  where one exists.

## Registration and capability surfaces

New or changed tools must remain synchronized across the repository-owned surfaces that describe or
validate them.

As applicable, run:

```bash
pnpm lint:tools
pnpm verify:tool-coverage
pnpm check:capability-docs
pnpm generate:tools-doc
```

If `pnpm generate:tools-doc` changes generated reference documentation, commit the intentional
generated diff. Do not hand-edit generated tool reference output to conceal registry drift.

## Verification

During focused iteration, run the relevant Vitest tests plus:

```bash
pnpm typecheck
pnpm lint:tools
pnpm verify:tool-coverage
pnpm verify:fast
```

Before handoff or PR creation, run the root `pnpm verify` contract.

For live EasyEDA mutation changes, mocked tests establish contract behavior but do not establish live
runtime compatibility. Record fresh live evidence when the repository release/compatibility policy
requires it.

## Definition of done

A tool change is complete only when its schema, metadata, authorization semantics, implementation,
tests, generated references, and runtime evidence tell the same story.
