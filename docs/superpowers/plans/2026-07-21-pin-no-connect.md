# Native Pin No-Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded, reversible MCP tool that sets EasyEDA Pro's native component-pin no-connect state with exact pin resolution and post-write verification.

**Architecture:** Add typed bridge read/write methods implemented in both the extension dispatcher and CDP bridge. Expose the state through the existing pin-read tool, add a dedicated confirmed-write MCP tool, and integrate a rollback-capable batch operation. No standalone schematic primitive is created.

**Tech Stack:** TypeScript 6, Zod 4, Vitest 4, EasyEDA Pro Extension API, MCP tool registry.

## Global Constraints

- Repository-visible text and documentation are English.
- Do not extend `schematic.createNetFlag` with a no-connect enum.
- Do not call `SCH_PrimitiveComponent.createShortCircuitFlag`.
- Resolve one exact component pin by `primitiveId` and `pinNumber`; reject zero or multiple matches.
- Mutate only the component pin's `noConnected` state.
- Require `confirmWrite: true` for every write path.
- Return real pin IDs and verify state after every write.
- Keep the PR draft until live macOS/EasyEDA ERC and save/reopen validation is completed.

---

### Task 1: Extend component-pin readback

**Files:**

- Modify: `src/tools/schematic-helpers.ts`
- Modify: `src/tools/L1_schematic_read.ts`
- Test: `tests/unit/tools/schematic.test.ts`

**Interfaces:**

- Produces: `BridgeSchematicPin.primitiveId?: string` and `BridgeSchematicPin.noConnected?: boolean`.

- [ ] Add failing tests for direct and nested pin primitive ID/no-connect fields.
- [ ] Run `pnpm vitest run tests/unit/tools/schematic.test.ts` and confirm failure.
- [ ] Normalize `primitiveId`, `PrimitiveId`, `noConnected`, and `NoConnected` in `fetchComponentPins`.
- [ ] Add optional fields to the MCP output schema and update the read-tool description/version.
- [ ] Run the focused test and confirm success.
- [ ] Commit as `feat(schematic): expose native no-connect pin state`.

### Task 2: Add extension bridge read/write methods

**Files:**

- Modify: `src/bridge/types.ts`
- Modify: `easyeda-bridge-extension/src/dispatcher.ts`
- Test: `easyeda-bridge-extension/tests/dispatcher.test.ts`

**Interfaces:**

- Produces: `schematic.getPinNoConnect` and `schematic.setPinNoConnect`.
- Returns: `{ componentPrimitiveId, pinPrimitiveId, pinNumber, pinName, previousNoConnected?, noConnected, changed?, verified? }`.

- [ ] Add failing dispatcher tests for readback, set/clear via setter+done, class-modify fallback, missing pin, duplicate pin, and verification mismatch.
- [ ] Add both method names to the dispatcher allowlist and server bridge schema.
- [ ] Implement exact pin resolution with typed bridge errors.
- [ ] Implement read-only state return.
- [ ] Implement setter+done first and `SCH_PrimitivePin.modify` fallback second.
- [ ] Re-read and compare the final boolean; throw `PIN_NO_CONNECT_VERIFY_FAILED` on mismatch.
- [ ] Run extension dispatcher tests and server bridge-schema tests.
- [ ] Commit as `feat(bridge): support native pin no-connect state`.

### Task 3: Add CDP bridge parity

**Files:**

- Modify: `src/bridge/cdp-manager.ts`
- Create: `tests/unit/bridge/cdp-manager-pin-no-connect.test.ts`

**Interfaces:**

- Consumes: the bridge methods from Task 2.
- Produces: CDP expressions with the same payload and error behavior.

- [ ] Add failing tests that inspect generated CDP calls for get/set methods and mapped-write enforcement.
- [ ] Map the read method without write authorization.
- [ ] Map the write method through `requireMappedWriteAllowed`.
- [ ] Generate exact-pin resolution, setter/modify fallback, and readback verification expressions.
- [ ] Run the focused CDP tests.
- [ ] Commit as `feat(cdp): map native pin no-connect operations`.

### Task 4: Add the MCP write tool

**Files:**

- Modify: `src/tools/L1_schematic_write.ts`
- Test: `tests/unit/tools/schematic.test.ts`
- Modify: `tests/unit/tools/registry.test.ts` if metadata expectations change.

**Interfaces:**

- Produces: `easyeda_schematic_set_pin_no_connect`.

- [ ] Add failing handler tests for default set, explicit clear, error-code preservation, and confirmation/schema validation.
- [ ] Add the Zod input/output schemas and registered tool metadata.
- [ ] Call `schematic.setPinNoConnect` and map bridge fields to snake_case MCP output.
- [ ] Preserve structured bridge error codes when present.
- [ ] Run focused schematic and registry tests.
- [ ] Commit as `feat(schematic): add native pin no-connect tool`.

### Task 5: Add atomic batch support

**Files:**

- Modify: `src/tools/L1_schematic_batch.ts`
- Test: `tests/unit/tools/schematic-batch.test.ts`

**Interfaces:**

- Produces batch action:
  `{ operationId, action: "setPinNoConnect", primitiveId, pinNumber, noConnected }`.

- [ ] Add failing tests for dry-run planning, successful apply, and rollback to the prior boolean.
- [ ] Extend batch schemas and output action enum.
- [ ] Use `schematic.getPinNoConnect` as the transaction snapshot.
- [ ] Apply and restore through `schematic.setPinNoConnect`.
- [ ] Run the focused batch tests.
- [ ] Commit as `feat(batch): support pin no-connect mutations`.

### Task 6: Update docs and live validation guidance

**Files:**

- Modify: `docs/net-creation-tools.md`
- Modify: `docs/reference/tools.md` through the repository metadata generator where applicable.
- Modify: `skills/easyeda-workflow/SKILL.md`
- Modify: `.opencode/skills/easyeda-workflow/SKILL.md`
- Modify: `scripts/e2e/live.mjs`
- Test: repository metadata/tool-coverage tests.

**Interfaces:**

- Documents the distinction between no-connect pin state, net flags, and short-circuit flags.

- [ ] Add an English usage example for setting and clearing a pin marker.
- [ ] Add a live validation step that verifies readback, ERC behavior, save/reopen persistence, and clear behavior on a disposable project.
- [ ] Regenerate tool reference metadata with the repository command.
- [ ] Run metadata, docs, and tool-coverage checks.
- [ ] Commit as `docs(schematic): document native pin no-connect support`.

### Task 7: Final verification and draft PR

**Files:**

- Review all changed files.

- [ ] Run focused server, extension, CDP, and batch tests.
- [ ] Run `mise exec node@24.18.0 -- corepack pnpm verify` with the Node 24 bin directory first on `PATH`.
- [ ] Run pre-commit, actionlint, zizmor, Semgrep, and dependency audit as required by repository policy.
- [ ] Inspect the final diff for unrelated changes and secrets.
- [ ] Push `research/no-connect-probe`.
- [ ] Open a draft PR linked to #328, explicitly marking live macOS/EasyEDA validation as pending.
- [ ] Check every bot/agent review and CI result; fix real findings before reporting completion.
