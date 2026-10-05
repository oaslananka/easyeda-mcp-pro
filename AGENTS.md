# Agent Repository Router

These instructions apply to the entire repository. Prefer repository-owned commands and policy
files over inferred conventions.

## Scope and precedence

- This root file applies repository-wide.
- Nested `AGENTS.md` files add or narrow instructions for their subtree.
- When instructions conflict, the closest applicable `AGENTS.md` wins.
- Nested instructions must not weaken repository security, approval, evidence, release, or product
  claim constraints unless the underlying policy is intentionally changed in the same work.
- Executable repository policy and tests remain authoritative if prose drifts.

Nested instruction boundaries:

- `src/tools/AGENTS.md` — MCP tool metadata, schemas, mutation safety, profiles, scopes, and
  transaction behavior.
- `src/remote/AGENTS.md` — remote gateway, pairing, approval, session routing, scopes, replay
  protection, and audit behavior.
- `easyeda-bridge-extension/AGENTS.md` — EasyEDA browser extension runtime, local/remote bridge
  transport, mutation execution, hot-swap, packaging, and live verification.
- `.github/AGENTS.md` — CI, branch-protection interfaces, security automation, release publication,
  provenance, and registry promotion.

## Start here

- `README.md` for product scope and local setup.
- `CONTRIBUTING.md` for coding, testing, branching, and review rules.
- `SECURITY.md` and `docs/security-architecture.md` for trust boundaries.
- `docs/SAFETY_MODEL.md` for EasyEDA mutation safety.
- `docs/TOOL_APPROVAL_POLICY.md` for remote approval semantics.
- `docs/agent-runtime-config.md` for MCP-capable agent runtimes.
- `docs/benchmark-suite.md` for mocked golden evals and their limits.
- `docs/RELEASE_POLICY.md` for release-channel, evidence, and recovery rules.

## Repository map

- `src/`: MCP server, tools, bridge client, remote transport, EDA analysis, and workflows.
- `src/tools/`: registered MCP tool definitions and execution-policy metadata.
- `src/remote/`: hosted/self-hosted remote gateway and approval/session boundary.
- `easyeda-bridge-extension/`: EasyEDA Pro browser/runtime extension workspace package.
- `tests/`: server, policy, security, integration, and eval coverage.
- `.github/workflows/`: protected CI, security, release, and scheduled automation.
- `scripts/`: repository-owned verification, release, generation, and E2E helpers.
- `skills/`: canonical product-owned agent skills.
- `.agents/skills/`, `.claude/skills/`, `.codex/skills/`, and `.opencode/skills/`: runtime-specific
  skill distributions or mirrors.

## Runtime contract

The supported development runtime is intentionally pinned.

- Node.js: `24.21.0`
- pnpm: `11.28.0`

Start with:

```bash
node scripts/check-runtime.mjs --require-pnpm
```

Runtime upgrades are atomic repository-wide changes. Do not update only `packageManager`, a
workflow, Docker metadata, `.node-version`, `.nvmrc`, or one documentation surface. Follow the
runtime parity procedure in `CONTRIBUTING.md` and update every surface reported by the repository
checkers in one focused change.

## Verification contract

- During iteration: run targeted tests, then `pnpm verify:fast`.
- Before handoff or PR creation: run `pnpm verify`.
- `pnpm security:audit` depends on the package registry and may fail or hang for environmental
  reasons; do not classify that as a repository defect without advisory evidence.
- Live EasyEDA tests are opt-in and require a connected disposable project; never substitute mocked
  golden evals for live-behaviour proof.
- For a narrow subtree change, also follow the closest nested `AGENTS.md` verification guidance.

## Safety rules

- Read-only inspection may proceed without mutation.
- Require explicit user approval before the first live EasyEDA write, then preview/apply/read back
  and verify the result.
- Never bypass `confirmWrite`, remote approval, scope checks, dependency-audit policy, release-age
  policy, secret hygiene, or branch protection to make a check pass.
- Treat timeouts during live writes as ambiguous state: read back before any retry.
- Do not claim manufacturing approval, fabrication readiness, supplier approval, or electrical
  correctness solely from automated DRC/ERC/BOM/export results.
- Beta or version-sensitive EasyEDA APIs require explicit capability handling and must fail closed
  when the required runtime surface is unavailable.

## Agent skills

`skills/` is the canonical repository source for product-owned skill contracts.

Runtime-specific skill copies or wrappers under `.agents/`, `.claude/`, `.codex/`, and
`.opencode/` must not become independent sources of truth. When a canonical skill changes:

1. update the canonical skill first;
2. update or regenerate every applicable runtime distribution;
3. preserve equivalent safety invariants across distributions;
4. update the relevant distribution tests and agent-runtime validation when needed.

Do not infer product capability from a skill or environment-variable name alone. Runtime
capabilities, profiles, maturity, and feature flags remain authoritative.

## Generated and policy-owned state

- Do not hand-edit generated outputs when a repository generator/check command owns them.
- Repository policy scripts are enforcement code, not disposable tooling. Do not weaken a checker
  merely to make CI pass.
- Keep tool/reference documentation, compatibility metadata, capability counts, runtime metadata,
  package artifacts, and extension artifacts synchronized through repository-owned commands.
- Preserve SHA-pinned GitHub Actions and dependency/runtime pins unless the change explicitly updates
  them.

## Change discipline

- Keep changes scoped and add regression tests for bug fixes or behavior changes.
- Respect architecture boundaries enforced by `pnpm check:architecture`.
- Avoid moving security decisions into transport adapters or documentation-only groupings.
- Public MCP tool names, schemas, bridge protocol fields, environment variables, configuration keys,
  and CLI behavior are compatibility surfaces; follow deprecation policy before breaking them.
- Keep the working tree understandable: inspect `git diff` and `git status` before handoff.

## Definition of done

A change is complete only when:

- the implementation matches the documented trust and architecture boundaries;
- relevant focused tests pass;
- generated/policy-owned state is synchronized;
- `pnpm verify:fast` passes during iteration;
- `pnpm verify` passes before handoff or PR creation unless a clearly identified environmental
  dependency prevents it;
- live-behavior claims are backed by live evidence rather than mocked fixtures;
- no security, approval, release, provenance, or manufacturing claim was silently weakened.
