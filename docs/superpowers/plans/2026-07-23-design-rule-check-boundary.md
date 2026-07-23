# Design Rule-Check Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `design.drc`, `design.erc`, and `design.ruleCheck` from `dispatcher.ts` into a typed, fully covered design-rule-check domain without changing native calls, normalization, fallback order, errors, or the 67-method public contract.

**Architecture:** Add a factory module that owns DRC/ERC normalization and orchestration. Inject `callFirst`, bridge-error creation, recoverable logging, error-message conversion, and floating-pin discovery; initialize the factory in `createDispatcher()` and leave three thin switch delegates.

**Tech Stack:** TypeScript 6, Vitest 4, Node.js 24.18.0, pnpm 11.5.1, esbuild-based extension packaging.

## Global Constraints

- Canonical base behavior is GitHub `main` commit `18c5217083da7f8a705d8dc246e82fc9ed734caf`.
- Preserve exactly 67 public bridge methods.
- Preserve native calls as `check(true, true, true)`.
- Preserve PCB-first fallback order for `design.ruleCheck`.
- Preserve existing `CONTEXT_UNAVAILABLE` messages, suggestions, and cause data.
- Preserve best-effort floating-pin inference semantics for `design.erc`.
- New module coverage must be 100% statements, branches, functions, and lines.
- Use `TMPDIR="$PWD/.tmp/test-runtime"` for local verification on MSI to avoid the known shared `/tmp/easyeda-bridge-extension.*` fixture collision.

---

### Task 1: Lock the extracted rule-check contract with RED tests

**Files:**

- Create: `easyeda-bridge-extension/tests/design-rule-check-operations.test.ts`

**Interfaces:**

- Consumes: future `createDesignRuleCheckOperations(dependencies)` factory.
- Produces: executable contract for `runDrc()`, `runErc()`, and `runRuleCheck()`.

- [ ] **Step 1: Create the focused test file with the factory contract**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createDesignRuleCheckOperations } from '../src/design-rule-check-operations.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function createSubject(overrides: Record<string, unknown> = {}) {
  const callFirst = vi.fn();
  const findFloatingPins = vi.fn().mockResolvedValue({ floatingPins: [], partRefs: [] });
  const logRecoverableError = vi.fn();
  const operations = createDesignRuleCheckOperations({
    callFirst,
    createBridgeError: bridgeError,
    logRecoverableError,
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    findFloatingPins,
    ...overrides,
  });
  return { operations, callFirst, findFloatingPins, logRecoverableError };
}

describe('design rule-check operations', () => {
  it('normalizes detailed leaves and nested UI trees', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      {
        name: 'Netlist mismatch',
        count: 1,
        list: [
          {
            ruleName: 'Missing connection',
            message: 'U1.1 is disconnected',
            severity: 'fatal',
            position: { x: 10, y: 20 },
            layer: 'TopLayer',
          },
        ],
      },
    ]);

    await expect(operations.runDrc()).resolves.toMatchObject({
      totalViolations: 1,
      errorCount: 1,
      warningCount: 0,
      passed: false,
      violations: [
        {
          rule: 'Missing connection',
          description: 'U1.1 is disconnected',
          severity: 'error',
          location: { x: 10, y: 20, layer: 'TopLayer' },
        },
      ],
    });
    expect(callFirst).toHaveBeenCalledWith(['PCB_Drc.check'], true, true, true);
  });

  it('counts flat aggregate groups without inventing leaf detail', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      { type: 'error', count: 2 },
      { type: 'warn', count: 3 },
      { type: 'info', count: 4 },
    ]);

    await expect(operations.runDrc()).resolves.toMatchObject({
      totalViolations: 9,
      errorCount: 2,
      warningCount: 3,
      passed: false,
    });
  });

  it('translates an inactive PCB context for design.drc', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockRejectedValue(new Error('no PCB canvas'));

    await expect(operations.runDrc()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: 'PCB DRC is unavailable in the current editor context.',
      suggestion: 'Open and focus a PCB document, then retry design.drc.',
      data: { cause: 'no PCB canvas' },
    });
  });

  it('falls back from PCB to schematic for design.ruleCheck', async () => {
    const { operations, callFirst, logRecoverableError } = createSubject();
    callFirst
      .mockRejectedValueOnce(new Error('no PCB canvas'))
      .mockResolvedValueOnce([{ type: 'warn', count: 1 }]);

    await expect(operations.runRuleCheck()).resolves.toMatchObject({
      totalViolations: 1,
      errorCount: 0,
      warningCount: 1,
      passed: true,
    });
    expect(callFirst.mock.calls).toEqual([
      [['PCB_Drc.check'], true, true, true],
      [['SCH_Drc.check'], true, true, true],
    ]);
    expect(logRecoverableError).toHaveBeenCalledTimes(1);
  });

  it('reports both causes when neither canvas is available', async () => {
    const { operations, callFirst } = createSubject();
    callFirst
      .mockRejectedValueOnce(new Error('no PCB canvas'))
      .mockRejectedValueOnce(new Error('no schematic canvas'));

    await expect(operations.runRuleCheck()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      data: { pcbCause: 'no PCB canvas', schematicCause: 'no schematic canvas' },
    });
  });

  it('supplements ERC with inferred floating pins', async () => {
    const floatingPins = [{ primitiveId: 'p1', designator: 'U1', pinNumber: '1' }];
    const { operations, callFirst, findFloatingPins } = createSubject();
    callFirst.mockResolvedValue([{ type: 'warn', count: 1 }]);
    findFloatingPins.mockResolvedValue({ floatingPins, partRefs: ['U1'] });

    await expect(operations.runErc()).resolves.toMatchObject({
      inferredFloatingPins: floatingPins,
      detailSource: 'inferred_partial',
    });
  });

  it('contains ERC inference failures and returns the native aggregate', async () => {
    const { operations, callFirst, findFloatingPins, logRecoverableError } = createSubject();
    callFirst.mockResolvedValue([{ type: 'warn', count: 1 }]);
    findFloatingPins.mockRejectedValue(new Error('inference failed'));

    await expect(operations.runErc()).resolves.toMatchObject({
      inferredFloatingPins: [],
      detailSource: 'native_aggregate_only',
      warningCount: 1,
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'design.erc: floating-pin inference failed',
      expect.any(Error),
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/design-rule-check-operations.test.ts
```

Expected: FAIL because `../src/design-rule-check-operations.js` does not exist.

- [ ] **Step 3: Commit the RED contract**

```bash
git add easyeda-bridge-extension/tests/design-rule-check-operations.test.ts
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'test(extension): lock design rule-check boundary'
```

### Task 2: Implement the typed rule-check domain

**Files:**

- Create: `easyeda-bridge-extension/src/design-rule-check-operations.ts`
- Test: `easyeda-bridge-extension/tests/design-rule-check-operations.test.ts`

**Interfaces:**

- Consumes:
  - `callFirst(paths: string[], ...args: unknown[]): Promise<unknown>`
  - `createBridgeError(code, message, suggestion, data?)`
  - recoverable logger and floating-pin callback
- Produces:
  - `DesignRuleCheckOperations.runDrc()`
  - `DesignRuleCheckOperations.runErc()`
  - `DesignRuleCheckOperations.runRuleCheck()`
  - `DesignRuleCheckOperations.runSchematicCheck()` for the existing `schematic.validateNetlist` native cross-check

- [ ] **Step 1: Add the complete module implementation**

```ts
export type DrcSeverity = 'error' | 'warning' | 'info';

export interface DrcResult {
  violations: Array<Record<string, unknown>>;
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  passed: boolean;
}

export interface FloatingPin {
  primitiveId: string;
  designator: string;
  pinNumber: string;
}

export interface DesignRuleCheckDependencies {
  callFirst: (paths: string[], ...args: unknown[]) => Promise<unknown>;
  createBridgeError: (code: string, message: string, suggestion: string, data?: unknown) => Error;
  logRecoverableError: (message: string, error: unknown) => void;
  errorMessage: (error: unknown) => string;
  findFloatingPins: () => Promise<{ floatingPins: FloatingPin[]; partRefs: string[] }>;
}

export interface DesignRuleCheckOperations {
  runDrc: () => Promise<DrcResult>;
  runErc: () => Promise<
    DrcResult & {
      inferredFloatingPins: FloatingPin[];
      detailSource: 'inferred_partial' | 'native_aggregate_only';
    }
  >;
  runRuleCheck: () => Promise<DrcResult>;
}

function normalizeSeverity(raw: unknown): DrcSeverity {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('fatal') || value.includes('error')) return 'error';
  if (value.includes('warn')) return 'warning';
  return 'info';
}

function normalizeViolation(item: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> = item && typeof item === 'object' ? { ...item } : {};
  const explanation =
    obj.explanation && typeof obj.explanation === 'object'
      ? (obj.explanation as Record<string, unknown>).str
      : undefined;
  const message =
    obj.message ?? obj.msg ?? obj.description ?? obj.text ?? obj.detail ?? explanation ?? item;
  const severitySource = [
    obj.level,
    obj.severity,
    obj.type,
    obj.errorLevel,
    obj.errorType,
    obj.errorObjType,
    obj.name,
    obj.ruleName,
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(' ');
  const position =
    obj.position && typeof obj.position === 'object'
      ? (obj.position as Record<string, unknown>)
      : obj.location && typeof obj.location === 'object'
        ? (obj.location as Record<string, unknown>)
        : obj;
  return {
    rule: String(
      obj.rule ??
        obj.ruleName ??
        obj.ruleTypeName ??
        obj.errorType ??
        obj.name ??
        obj.type ??
        'unknown',
    ),
    description: typeof message === 'string' ? message : JSON.stringify(message),
    severity: normalizeSeverity(severitySource),
    net: obj.net ?? obj.netName ?? undefined,
    component: obj.component ?? obj.ref ?? obj.designator ?? obj.primitiveId ?? undefined,
    location:
      typeof position.x === 'number' && typeof position.y === 'number'
        ? { x: position.x, y: position.y, layer: obj.layer as string | undefined }
        : undefined,
  };
}

function normalizeAggregate(item: unknown): { severity: DrcSeverity; count: number } | null {
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!obj || typeof obj.count !== 'number') return null;
  const source = [
    obj.type,
    obj.severity,
    obj.level,
    obj.errorType,
    obj.errorObjType,
    obj.name,
    Array.isArray(obj.title) ? obj.title.join(' ') : obj.title,
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(' ');
  return { severity: normalizeSeverity(source), count: obj.count };
}

function hasLeafDetail(obj: Record<string, unknown>): boolean {
  return [
    'message',
    'msg',
    'description',
    'text',
    'detail',
    'explanation',
    'errorType',
    'errorObjType',
    'rule',
    'ruleName',
    'ruleTypeName',
  ].some((key) => obj[key] !== undefined);
}

function normalizeNode(item: unknown): {
  violations: Array<Record<string, unknown>>;
  aggregates: Array<{ severity: DrcSeverity; count: number }>;
} {
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!obj) return { violations: [normalizeViolation(item)], aggregates: [] };
  const children = Array.isArray(obj.list) ? obj.list : [];
  if (children.length > 0) {
    const normalized = children.map(normalizeNode);
    const violations = normalized.flatMap((entry) => entry.violations);
    const aggregates = normalized.flatMap((entry) => entry.aggregates);
    if (violations.length > 0 || aggregates.length > 0) return { violations, aggregates };
  }
  if (hasLeafDetail(obj)) return { violations: [normalizeViolation(obj)], aggregates: [] };
  const aggregate = normalizeAggregate(obj);
  return { violations: [], aggregates: aggregate ? [aggregate] : [] };
}

export function createDesignRuleCheckOperations(
  dependencies: DesignRuleCheckDependencies,
): DesignRuleCheckOperations {
  const runNative = async (paths: string[]): Promise<DrcResult> => {
    const raw = await dependencies.callFirst(paths, true, true, true);
    const normalized = (Array.isArray(raw) ? raw : []).map(normalizeNode);
    const detailed = normalized.flatMap((entry) => entry.violations);
    const aggregates = normalized.flatMap((entry) => entry.aggregates);
    const violations = [
      ...detailed,
      ...aggregates
        .filter((entry) => entry.count > 0)
        .map((entry) => ({
          rule: 'aggregate',
          description:
            `${entry.count} ${entry.severity}(s) reported by EasyEDA's native design/electrical rule ` +
            'check. Per-violation detail is only shown in EasyEDA Pro when the API returns aggregate counts.',
          severity: entry.severity,
        })),
    ];
    const errorCount =
      detailed.filter((entry) => entry.severity === 'error').length +
      aggregates
        .filter((entry) => entry.severity === 'error')
        .reduce((sum, entry) => sum + entry.count, 0);
    const warningCount =
      detailed.filter((entry) => entry.severity === 'warning').length +
      aggregates
        .filter((entry) => entry.severity === 'warning')
        .reduce((sum, entry) => sum + entry.count, 0);
    return {
      violations,
      totalViolations: detailed.length + aggregates.reduce((sum, entry) => sum + entry.count, 0),
      errorCount,
      warningCount,
      passed: errorCount === 0,
    };
  };

  const runDrc = async (): Promise<DrcResult> => {
    try {
      return await runNative(['PCB_Drc.check']);
    } catch (error) {
      throw dependencies.createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'PCB DRC is unavailable in the current editor context.',
        'Open and focus a PCB document, then retry design.drc.',
        { cause: dependencies.errorMessage(error) },
      );
    }
  };

  const runRuleCheck = async (): Promise<DrcResult> => {
    let pcbError: unknown;
    try {
      return await runNative(['PCB_Drc.check']);
    } catch (error) {
      pcbError = error;
      dependencies.logRecoverableError(
        'design.ruleCheck: PCB DRC unavailable; trying schematic ERC/DRC',
        error,
      );
    }
    try {
      return await runNative(['SCH_Drc.check']);
    } catch (schematicError) {
      throw dependencies.createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'No active PCB or schematic canvas is available for design.ruleCheck.',
        'Open and focus a PCB or schematic document, then retry.',
        {
          pcbCause: dependencies.errorMessage(pcbError),
          schematicCause: dependencies.errorMessage(schematicError),
        },
      );
    }
  };

  const runErc = async () => {
    const result = await runNative(['SCH_Drc.check']);
    try {
      const { floatingPins } = await dependencies.findFloatingPins();
      return {
        ...result,
        inferredFloatingPins: floatingPins,
        detailSource:
          floatingPins.length > 0
            ? ('inferred_partial' as const)
            : ('native_aggregate_only' as const),
      };
    } catch (error) {
      dependencies.logRecoverableError('design.erc: floating-pin inference failed', error);
      return {
        ...result,
        inferredFloatingPins: [],
        detailSource: 'native_aggregate_only' as const,
      };
    }
  };

  return { runDrc, runErc, runRuleCheck };
}
```

- [ ] **Step 2: Run focused tests and verify GREEN**

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/design-rule-check-operations.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run focused coverage**

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/design-rule-check-operations.test.ts --coverage
```

Expected: `design-rule-check-operations.ts` reports 100% statements, branches, functions, and lines.

- [ ] **Step 4: Commit the domain implementation**

```bash
git add easyeda-bridge-extension/src/design-rule-check-operations.ts \
  easyeda-bridge-extension/tests/design-rule-check-operations.test.ts
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'refactor(extension): extract design rule checks'
```

### Task 3: Delegate the dispatcher and remove duplicate implementation

**Files:**

- Modify: `easyeda-bridge-extension/src/dispatcher.ts:1-3749`
- Modify: `easyeda-bridge-extension/tests/dispatcher.test.ts:1050-1408`

**Interfaces:**

- Consumes: `createDesignRuleCheckOperations()` from Task 2.
- Produces: three thin public delegates and one initialized `DesignRuleCheckOperations` instance.

- [ ] **Step 1: Add dispatcher import, field, and factory binding**

```ts
import {
  createDesignRuleCheckOperations,
  type DesignRuleCheckOperations,
} from './design-rule-check-operations.js';

let designRuleCheckOperations: DesignRuleCheckOperations;
```

Inside `createDispatcher()` after API runtime creation:

```ts
designRuleCheckOperations = createDesignRuleCheckOperations({
  callFirst,
  createBridgeError: newBridgeError,
  logRecoverableError,
  errorMessage,
  findFloatingPins: findFloatingPinsApi,
});
```

- [ ] **Step 2: Replace the three switch bodies with delegates**

```ts
case 'design.ruleCheck':
  return designRuleCheckOperations.runRuleCheck();
case 'design.erc':
  return designRuleCheckOperations.runErc();
case 'design.drc':
  return designRuleCheckOperations.runDrc();
```

- [ ] **Step 3: Delete only the moved rule-check helpers**

Delete the dispatcher-local definitions of:

```ts
normalizeDrcSeverity;
normalizeDrcViolation;
normalizeDrcAggregate;
hasDrcLeafDetail;
normalizeDrcNode;
runDrcCheck;
runPcbDrcCheck;
runRuleCheckForActiveCanvas;
```

Keep `errorMessage`, `findFloatingPinsApi`, `isConfirmedNativeNoConnect`, and connectivity inference in the dispatcher because they remain cross-domain dependencies. Route `schematic.validateNetlist` through `designRuleCheckOperations.runSchematicCheck()` so it does not retain a duplicate normalizer.

- [ ] **Step 4: Add dispatcher delegation parity assertions**

In `dispatcher.test.ts`, retain all current behavioral tests and add one call-order test that dispatches all three methods through injected native classes. Assert:

```ts
expect(dispatcher.methodList).toHaveLength(67);
expect(dispatcher.methodList).toContain('design.drc');
expect(dispatcher.methodList).toContain('design.erc');
expect(dispatcher.methodList).toContain('design.ruleCheck');
```

- [ ] **Step 5: Run focused parity**

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/design-rule-check-operations.test.ts tests/dispatcher.test.ts
```

Expected: all rule-check module and dispatcher tests PASS.

- [ ] **Step 6: Commit dispatcher delegation**

```bash
git add easyeda-bridge-extension/src/dispatcher.ts \
  easyeda-bridge-extension/tests/dispatcher.test.ts
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'refactor(extension): delegate design rule checks'
```

### Task 4: Verify and prepare Pull Request 1

**Files:**

- Modify: `docs/superpowers/plans/2026-07-23-design-rule-check-boundary.md` only to append measured execution evidence.

**Interfaces:**

- Produces: reviewable PR evidence; issue #339 remains open.

- [ ] **Step 1: Run full verification at exact head**

```bash
mkdir -p .tmp/test-runtime
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" pnpm verify
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" pnpm test:extension:ci
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH pnpm verify:extension
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH pnpm check:extension-size
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH pnpm security:audit
```

Expected: all commands exit 0; server suite remains 1,740 tests; public methods remain 67; new module coverage is 100%.

- [ ] **Step 2: Record objective measurements**

```bash
wc -l easyeda-bridge-extension/src/dispatcher.ts
wc -c easyeda-bridge-extension/dist/dispatcher.js
git diff --stat 18c5217083da7f8a705d8dc246e82fc9ed734caf...HEAD
```

Append actual counts to this plan under `## Execution Evidence`.

- [ ] **Step 3: Commit evidence and push the PR branch**

```bash
git add docs/superpowers/plans/2026-07-23-design-rule-check-boundary.md
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'docs: record rule-check extraction evidence'
git push -u origin refactor/issue-339-design-rule-check
```

PR title:

```text
refactor(extension): extract design rule-check operations
```

PR body must use `Refs #339`, not a closing keyword, and include test, coverage, line-count, bundle-size, and security evidence.

## Execution Evidence

Collected after the Sonar follow-up at implementation head `010e664be65b028d61d55bc3f4bf3379f36844a3` on Node.js 24.18.0 and pnpm 11.5.1:

- Dispatcher source: 3,749 → 3,533 lines (-216).
- Extracted module: 272 lines.
- Public extension method list: 67 → 67.
- Focused rule-check/domain parity: 110 tests passed.
- Server suite: 150 files / 1,740 tests passed.
- Extension suite: 22 files / 260 tests passed.
- `design-rule-check-operations.ts`: 100% statements / branches / functions / lines.
- `pnpm verify`: passed.
- `pnpm test:extension:ci`: passed.
- Extension distribution verification: passed.
- Packaged extension: 163,894 / 200,000 bytes.
- Extension entry bundle: 223,726 / 260,000 bytes.
- Dispatcher bundle: 163,312 / 185,000 bytes.
- Dependency audit policy: passed with only the existing documented #334 advisory exception.
- Sonar review findings were addressed by restricting severity, rule, title, component, and aggregate normalization inputs to native scalar values; object-valued fields no longer leak `[object Object]` into bridge results.
- No peer-dependency validation script is defined in the repository package scripts.
- MSI checksum fixtures were run with a worktree-local `TMPDIR` to avoid the pre-existing shared `/tmp/easyeda-bridge-extension.*` ownership collision; no repository behavior was changed for that environment issue.
