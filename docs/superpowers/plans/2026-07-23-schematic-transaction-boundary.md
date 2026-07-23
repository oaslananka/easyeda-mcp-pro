# Schematic Transaction Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the six schematic transaction bridge methods and their safety machinery from `dispatcher.ts` into a typed, fully covered domain module, then close #339 after exact-head and post-merge acceptance verification.

**Architecture:** Add a factory module that owns snapshot parsing, primitive discovery, ownership-aware deletion, recreation, safe partial modification, text alignment replay protection, and connected-wire following. Keep helpers used by non-transaction schematic paths in the dispatcher and inject them as narrow typed callbacks; replace six switch bodies with delegates.

**Tech Stack:** TypeScript 6, Vitest 4, Node.js 24.18.0, pnpm 11.5.1, EasyEDA Pro bridge runtime.

## Global Constraints

- Start after the design-rule-check PR is merged or rebased into this branch.
- Preserve exactly 67 public bridge methods.
- Preserve schema version `schematic-primitive-snapshot/v1` exactly.
- Preserve error codes, messages, suggestions, and data unless an existing test proves an unsafe ambiguity.
- Never stringify object-valued primitive IDs.
- Preserve public text alignment values 1 through 9 and never replay internal `getAll()` encodings.
- Preserve text and rectangle Y-axis sign conversion during recreation.
- Preserve ownership-aware deletion and `success: false` when any ID is not found.
- Preserve component movement wire-following and recoverable wire failures.
- New module coverage must be 100% statements, branches, functions, and lines.
- Use `TMPDIR="$PWD/.tmp/test-runtime"` for MSI verification.

---

### Task 1: Define the transaction factory and lock RED behavior

**Files:**

- Create: `easyeda-bridge-extension/tests/schematic-transaction-operations.test.ts`

**Interfaces:**

- Consumes: future `createSchematicTransactionOperations(dependencies)` factory.
- Produces: focused domain contract independent from the dispatcher switch.

- [ ] **Step 1: Create dependency fixtures and initial failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSchematicTransactionOperations } from '../src/schematic-transaction-operations.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function state(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const getter = record[`getState_${key}`];
  if (typeof getter === 'function') return getter.call(source);
  if (typeof record.getState === 'function') {
    const value = record.getState.call(source) as Record<string, unknown>;
    if (value && key in value) return value[key];
  }
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  return record[key] ?? record[lower];
}

function createSubject(classes: Record<string, unknown> = {}) {
  const textAlignCache = new Map<string, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9>();
  const callFirst = vi.fn();
  const logRecoverableError = vi.fn();
  const operations = createSchematicTransactionOperations({
    callFirst,
    readFirstPath: (paths) => paths.map((path) => classes[path]).find(Boolean),
    readState: state,
    extractPrimitiveId: (value) => {
      if (!value || typeof value !== 'object') return '';
      const record = value as Record<string, unknown>;
      const raw = record.primitiveId ?? record.uuid ?? state(value, 'PrimitiveId');
      return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint'
        ? String(raw)
        : '';
    },
    readComponentType: (value) => String(state(value, 'ComponentType') ?? '').toLowerCase(),
    readPinPoint: (value) => ({
      x: state(value, 'X') as number | undefined,
      y: state(value, 'Y') as number | undefined,
      rotation: state(value, 'Rotation') as number | undefined,
    }),
    createBridgeError: bridgeError,
    logRecoverableError,
    asPublicTextAlignMode: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9
        ? (value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9)
        : undefined,
    requirePublicTextAlignMode: (value, field = 'alignMode') => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9) {
        throw bridgeError(
          'INVALID_PARAMS',
          `${field} must be an integer from 1 through 9`,
          'Use the documented ESCH_PrimitiveTextAlignMode values: LEFT_TOP=1 through RIGHT_BOTTOM=9.',
        );
      }
      return value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    },
    getCachedTextAlignMode: (primitiveId) => textAlignCache.get(primitiveId),
    setCachedTextAlignMode: (primitiveId, alignMode) => textAlignCache.set(primitiveId, alignMode),
    deleteCachedTextAlignMode: (primitiveId) => textAlignCache.delete(primitiveId),
  });
  return { operations, callFirst, logRecoverableError, textAlignCache };
}

describe('schematic transaction operations', () => {
  it('captures a scalar-safe component snapshot', async () => {
    const component = {
      getState_PrimitiveId: () => 'cmp-1',
      getState_ComponentType: () => 'component',
      getState_X: () => 10,
      getState_Y: () => 20,
      getState_Designator: () => 'U1',
      getState_OtherProperty: () => ({ value: 'MCU' }),
    };
    const { operations } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(component) },
    });

    await expect(operations.getPrimitiveSnapshot('cmp-1')).resolves.toMatchObject({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'cmp-1',
      primitiveKind: 'component',
      property: { x: 10, y: 20, designator: 'U1', otherProperty: { value: 'MCU' } },
    });
  });

  it('rejects malformed restore input before mutation', async () => {
    const { operations, callFirst } = createSubject();
    await expect(
      operations.restorePrimitiveSnapshot({ schemaVersion: 'wrong' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'snapshot does not match schematic-primitive-snapshot/v1',
    });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('does not stringify object-valued primitive IDs', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([{ primitiveId: { unsafe: true } }]),
      },
    });
    await expect(operations.listPrimitiveIds('wire')).resolves.toEqual({
      primitiveKind: 'wire',
      primitiveIds: [],
    });
  });

  it('routes deletion to the owning class and reports missing IDs', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const wireDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn(async (id) => (id === 'cmp-1' ? { primitiveId: id } : undefined)),
        delete: componentDelete,
      },
      SCH_PrimitiveWire: {
        get: vi.fn(async (id) => (id === 'wire-1' ? { primitiveId: id } : undefined)),
        delete: wireDelete,
      },
    });

    await expect(operations.deletePrimitives(['cmp-1', 'wire-1', 'missing'])).resolves.toEqual({
      success: false,
      deleted: ['cmp-1', 'wire-1'],
      notFound: ['missing'],
    });
    expect(componentDelete).toHaveBeenCalledWith(['cmp-1']);
    expect(wireDelete).toHaveBeenCalledWith(['wire-1']);
  });

  it('rejects component recreation without a complete creation descriptor', async () => {
    const { operations } = createSubject();
    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'cmp-1',
        primitiveKind: 'component',
        property: {},
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/schematic-transaction-operations.test.ts
```

Expected: FAIL because `schematic-transaction-operations.ts` does not exist.

- [ ] **Step 3: Commit the RED contract**

```bash
git add easyeda-bridge-extension/tests/schematic-transaction-operations.test.ts
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'test(extension): lock schematic transaction boundary'
```

### Task 2: Implement snapshot, inventory, deletion, and recreation

**Files:**

- Create: `easyeda-bridge-extension/src/schematic-transaction-operations.ts`
- Modify: `easyeda-bridge-extension/tests/schematic-transaction-operations.test.ts`

**Interfaces:**

- Consumes the exact dependency callbacks shown below.
- Produces the six public transaction operations plus no new bridge methods.

- [ ] **Step 1: Add the factory interfaces and snapshot schema**

```ts
import { isRecord } from './utils.js';

export type PublicTextAlignMode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type SchematicPrimitiveSnapshotKind =
  'component' | 'netflag' | 'netport' | 'wire' | 'text' | 'rectangle' | 'circle' | 'polygon';

export interface SchematicPrimitiveSnapshot {
  schemaVersion: 'schematic-primitive-snapshot/v1';
  primitiveId: string;
  primitiveKind: SchematicPrimitiveSnapshotKind;
  componentType?: string;
  property: Record<string, unknown>;
}

export interface SchematicTransactionDependencies {
  callFirst: (paths: string[], ...args: unknown[]) => Promise<unknown>;
  readFirstPath: <T>(paths: string[]) => T | undefined;
  readState: (source: unknown, key: string) => unknown;
  extractPrimitiveId: (source: unknown) => string;
  readComponentType: (source: unknown) => string;
  readPinPoint: (source: unknown) => { x?: number; y?: number; rotation?: number };
  createBridgeError: (code: string, message: string, suggestion: string, data?: unknown) => Error;
  logRecoverableError: (message: string, error: unknown) => void;
  asPublicTextAlignMode: (value: unknown) => PublicTextAlignMode | undefined;
  requirePublicTextAlignMode: (value: unknown, field?: string) => PublicTextAlignMode;
  getCachedTextAlignMode: (primitiveId: string) => PublicTextAlignMode | undefined;
  setCachedTextAlignMode: (primitiveId: string, alignMode: PublicTextAlignMode) => void;
  deleteCachedTextAlignMode: (primitiveId: string) => void;
}

export interface SchematicTransactionOperations {
  getPrimitiveSnapshot: (
    primitiveId: string,
    expectedPrimitiveKind?: SchematicPrimitiveSnapshotKind,
  ) => Promise<SchematicPrimitiveSnapshot>;
  listPrimitiveIds: (
    primitiveKind: unknown,
  ) => Promise<{ primitiveKind: SchematicPrimitiveSnapshotKind; primitiveIds: string[] }>;
  deletePrimitives: (
    primitiveIds: unknown,
  ) => Promise<{ success: boolean; deleted: string[]; notFound: string[] }>;
  recreatePrimitiveSnapshot: (
    snapshot: unknown,
  ) => Promise<{ primitiveId: string; snapshot: SchematicPrimitiveSnapshot }>;
  restorePrimitiveSnapshot: (
    snapshot: unknown,
  ) => Promise<{ restored: true; snapshot: SchematicPrimitiveSnapshot }>;
  modifyPrimitive: (primitiveId: string, property: Record<string, unknown>) => Promise<unknown>;
}
```

- [ ] **Step 2: Move the exact transaction-only helper set into the factory closure**

Move these dispatcher definitions without changing messages, fallback order, property names, or native argument order:

```text
compactDefinedRecord
readPrimitiveFromClass
readPublicTextPrimitive
readPersistentTextPrimitive
validatedPublicTextPrimitive
readTextPrimitiveFromClass
componentSnapshotProperty
COMPONENT_CLASS_PATHS
WIRE_CLASS_PATHS
TEXT_CLASS_PATHS
RECTANGLE_CLASS_PATHS
CIRCLE_CLASS_PATHS
POLYGON_CLASS_PATHS
componentKindFromType
componentSnapshot
wireSnapshot
textSnapshot
rectangleSnapshot
circleSnapshot
polygonSnapshot
readComponentSnapshot
readClassSnapshot
readTextSnapshot
throwUnsupportedTextSnapshot
readSnapshotByKind
readUnconstrainedSnapshot
getSchematicPrimitiveSnapshot
parseSchematicPrimitiveSnapshot
RECREATABLE_SCHEMATIC_KINDS
schematicPrimitiveClassPaths
parseSchematicPrimitiveKind
primitiveIdFromValue
listSchematicPrimitiveIds
primitiveExistsInClass
deleteSchematicPrimitives
requiredSnapshotNumber
recreateSchematicPrimitiveSnapshot
```

Every former global access must use the injected dependency object. For example:

```ts
const primitiveClass = dependencies.readFirstPath<any>(paths);
const value = dependencies.readState(current, 'Line');
const primitiveId = dependencies.extractPrimitiveId(result);
throw dependencies.createBridgeError('INVALID_PARAMS', message, suggestion, data);
dependencies.logRecoverableError(context, error);
```

- [ ] **Step 3: Preserve text alignment resolution exactly**

```ts
interface TextPrimitiveRead {
  publicCurrent?: unknown;
  persistentCurrent?: unknown;
  className: string;
}

function readTextState(text: TextPrimitiveRead, key: string): unknown {
  const publicValue = dependencies.readState(text.publicCurrent, key);
  if (publicValue !== undefined) return publicValue;
  return dependencies.readState(text.persistentCurrent, key);
}

function resolvePublicTextAlignMode(
  text: TextPrimitiveRead,
  primitiveId: string,
): PublicTextAlignMode | undefined {
  const publicAlignMode = dependencies.asPublicTextAlignMode(
    dependencies.readState(text.publicCurrent, 'AlignMode'),
  );
  if (publicAlignMode !== undefined) {
    dependencies.setCachedTextAlignMode(primitiveId, publicAlignMode);
    return publicAlignMode;
  }
  return dependencies.getCachedTextAlignMode(primitiveId);
}
```

- [ ] **Step 4: Add recreation tests for every supported kind and ID path**

Extend the focused test file with table-driven cases for wire, text, rectangle, circle, and polygon. Assert exact `callFirst` path and arguments. Include:

```ts
it('recovers a recreated ID from an exact one-item inventory diff', async () => {
  const wireClass = {
    getAll: vi
      .fn()
      .mockResolvedValueOnce([{ primitiveId: 'before' }])
      .mockResolvedValueOnce([{ primitiveId: 'before' }, { primitiveId: 'after' }]),
    get: vi.fn(async (id) => ({ primitiveId: id, getState_Line: () => [0, 0, 10, 0] })),
  };
  const { operations, callFirst } = createSubject({ SCH_PrimitiveWire: wireClass });
  callFirst.mockResolvedValue({});

  await expect(
    operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'old',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'GND' },
    }),
  ).resolves.toMatchObject({ primitiveId: 'after' });
});
```

Add an ambiguity case where two IDs appear and expect `CREATE_UNCONFIRMED`.

- [ ] **Step 5: Run focused tests and coverage**

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/schematic-transaction-operations.test.ts --coverage
```

Expected: snapshot/inventory/delete/recreate tests pass. Coverage may remain below 100% until Task 3 adds modification branches.

- [ ] **Step 6: Commit the read/delete/recreate boundary**

```bash
git add easyeda-bridge-extension/src/schematic-transaction-operations.ts \
  easyeda-bridge-extension/tests/schematic-transaction-operations.test.ts
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'refactor(extension): extract schematic transaction snapshots'
```

### Task 3: Implement safe modification and connected-wire following

**Files:**

- Modify: `easyeda-bridge-extension/src/schematic-transaction-operations.ts`
- Modify: `easyeda-bridge-extension/tests/schematic-transaction-operations.test.ts`

**Interfaces:**

- Consumes snapshot/read helpers from Task 2.
- Produces complete `modifyPrimitive()` and `restorePrimitiveSnapshot()` behavior.

- [ ] **Step 1: Move the exact modification helper set into the module**

Move these definitions and replace dispatcher globals with dependencies:

```text
applyNetFlagState
getComponentPinCoordinates
shiftWireLine
followConnectedWires
```

Use this local point key implementation to preserve coordinate rounding:

```ts
function pointKey(point: { x: number; y: number }): string {
  return `${Math.round(point.x * 1000) / 1000},${Math.round(point.y * 1000) / 1000}`;
}
```

`getComponentPinCoordinates()` must call:

```ts
await dependencies.callFirst(
  [
    'SCH_PrimitiveComponent.getAllPinsByPrimitiveId',
    'sch_PrimitiveComponent.getAllPinsByPrimitiveId',
  ],
  primitiveId,
);
```

and use `dependencies.readPinPoint(pin)` so connect-pin behavior outside this module remains untouched.

- [ ] **Step 2: Implement `modifyPrimitive()` with the existing class order**

The class ownership order must remain:

```text
component/netflag/netport
wire
text
circle
polygon
generic component/wire fallback
```

For components, preserve this merged shape:

```ts
const merged: Record<string, unknown> = {
  x: oldX,
  y: oldY,
  rotation: dependencies.readState(current, 'Rotation'),
  mirror: dependencies.readState(current, 'Mirror'),
  addIntoBom: dependencies.readState(current, 'AddIntoBom'),
  addIntoPcb: dependencies.readState(current, 'AddIntoPcb'),
  designator: dependencies.readState(current, 'Designator'),
  name: dependencies.readState(current, 'Name'),
  uniqueId: dependencies.readState(current, 'UniqueId'),
  manufacturer: dependencies.readState(current, 'Manufacturer'),
  manufacturerId: dependencies.readState(current, 'ManufacturerId'),
  supplier: dependencies.readState(current, 'Supplier'),
  supplierId: dependencies.readState(current, 'SupplierId'),
  ...property,
  otherProperty: incomingOther ? { ...existingOther, ...incomingOther } : existingOther,
};
```

For text, preserve alias normalization and public alignment:

```ts
if (incoming.color !== undefined) incoming.textColor = incoming.color;
if (incoming.underline !== undefined) incoming.underLine = incoming.underline;
delete incoming.color;
delete incoming.underline;
incoming.alignMode = alignMode;
```

After a component position change, call `followConnectedWires()` and return:

```ts
return { result: modifyResult, followedWireIds, wireFollowFailures };
```

- [ ] **Step 3: Implement restore through the local safe modify operation**

```ts
const restorePrimitiveSnapshot = async (input: unknown) => {
  const snapshot = parseSchematicPrimitiveSnapshot(input);
  await modifyPrimitive(snapshot.primitiveId, snapshot.property);
  return {
    restored: true as const,
    snapshot: await getPrimitiveSnapshot(snapshot.primitiveId),
  };
};
```

This replaces the dispatcher-recursive call but preserves the same safe modification path and result contract.

- [ ] **Step 4: Add focused modification tests**

Add tests covering:

```text
component partial merge and first-level otherProperty merge
netflag low-level setters + done()
wire full-state merge
text public get() alignment and cache fallback
invalid text alignment
circle and polygon ownership
component movement wire endpoint translation
recoverable wire modification failure
no wire scan when x/y do not change
primitive fallback path
```

The wire-follow failure test must assert that component modification resolves and includes the failed wire ID instead of throwing.

- [ ] **Step 5: Reach focused 100% coverage**

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/schematic-transaction-operations.test.ts --coverage
```

Expected: `schematic-transaction-operations.ts` reports 100% statements, branches, functions, and lines.

- [ ] **Step 6: Commit safe mutation behavior**

```bash
git add easyeda-bridge-extension/src/schematic-transaction-operations.ts \
  easyeda-bridge-extension/tests/schematic-transaction-operations.test.ts
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'refactor(extension): extract schematic transaction mutations'
```

### Task 4: Wire six dispatcher delegates and remove duplicate helpers

**Files:**

- Modify: `easyeda-bridge-extension/src/dispatcher.ts:1-3749`
- Modify: `easyeda-bridge-extension/tests/dispatcher.test.ts:1974-2725`

**Interfaces:**

- Consumes: complete factory from Tasks 2 and 3.
- Produces: six thin switch delegates and one initialized domain instance.

- [ ] **Step 1: Import and initialize the domain**

```ts
import {
  createSchematicTransactionOperations,
  type SchematicPrimitiveSnapshotKind,
  type SchematicTransactionOperations,
} from './schematic-transaction-operations.js';

let schematicTransactionOperations: SchematicTransactionOperations;
```

Inside `createDispatcher()`:

```ts
schematicTransactionOperations = createSchematicTransactionOperations({
  callFirst,
  readFirstPath,
  readState: safeGetState,
  extractPrimitiveId,
  readComponentType,
  readPinPoint,
  createBridgeError: newBridgeError,
  logRecoverableError,
  asPublicTextAlignMode,
  requirePublicTextAlignMode,
  getCachedTextAlignMode: (primitiveId) => textAlignModeCache.get(primitiveId),
  setCachedTextAlignMode: (primitiveId, alignMode) =>
    textAlignModeCache.set(primitiveId, alignMode),
  deleteCachedTextAlignMode: (primitiveId) => textAlignModeCache.delete(primitiveId),
});
```

Keep `textAlignModeCache.clear()` in dispatcher initialization so cache lifetime remains one dispatcher instance.

- [ ] **Step 2: Replace six switch implementations**

```ts
case 'schematic.getPrimitiveSnapshot':
  return schematicTransactionOperations.getPrimitiveSnapshot(
    params.primitiveId as string,
    typeof params.expectedPrimitiveKind === 'string'
      ? (params.expectedPrimitiveKind as SchematicPrimitiveSnapshotKind)
      : undefined,
  );
case 'schematic.listPrimitiveIds':
  return schematicTransactionOperations.listPrimitiveIds(params.primitiveKind);
case 'schematic.deletePrimitive':
  return schematicTransactionOperations.deletePrimitives(params.primitiveIds);
case 'schematic.recreatePrimitiveSnapshot':
  return schematicTransactionOperations.recreatePrimitiveSnapshot(params.snapshot);
case 'schematic.restorePrimitiveSnapshot':
  return schematicTransactionOperations.restorePrimitiveSnapshot(params.snapshot);
case 'schematic.modifyPrimitive':
  return schematicTransactionOperations.modifyPrimitive(
    params.primitiveId as string,
    (params.property as Record<string, unknown>) || {},
  );
```

- [ ] **Step 3: Delete only helpers now owned exclusively by the transaction module**

Delete the exact helper set listed in Tasks 2 and 3. Keep shared dispatcher helpers:

```text
safeGetState
readComponentType
readPinPoint
extractPrimitiveId
asPublicTextAlignMode
requirePublicTextAlignMode
textAlignModeCache
```

because non-transaction paths still consume them.

- [ ] **Step 4: Retain and extend dispatcher parity tests**

Do not delete existing transaction behavior tests until every assertion has an equivalent focused-module test. Keep a compact dispatcher integration for all six method names and assert:

```ts
expect(dispatcher.methodList).toHaveLength(67);
expect(dispatcher.methodList.filter((method) => method.startsWith('schematic.'))).toContain(
  'schematic.getPrimitiveSnapshot',
);
```

- [ ] **Step 5: Run focused parity and typecheck**

```bash
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH \
TMPDIR="$PWD/.tmp/test-runtime" \
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/schematic-transaction-operations.test.ts tests/dispatcher.test.ts
PATH=/home/msi/.local/share/node-v24.18.0-linux-x64/bin:$PATH pnpm typecheck:extension
```

Expected: all tests and typecheck pass; public methods remain 67.

- [ ] **Step 6: Commit dispatcher delegation**

```bash
git add easyeda-bridge-extension/src/dispatcher.ts \
  easyeda-bridge-extension/tests/dispatcher.test.ts
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'refactor(extension): delegate schematic transactions'
```

### Task 5: Final acceptance, PR, merge, and issue closure

**Files:**

- Modify: `docs/superpowers/plans/2026-07-23-schematic-transaction-boundary.md` to append measured evidence.
- GitHub: final PR and issue #339 comment/state.

**Interfaces:**

- Produces: completed issue acceptance evidence and closure.

- [ ] **Step 1: Run all exact-head local gates**

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

Expected: all exit 0; server suite remains 1,740 tests or higher; extension suite passes; both new modules have 100% coverage; method count remains 67.

- [ ] **Step 2: Record measured acceptance data**

```bash
wc -l easyeda-bridge-extension/src/dispatcher.ts
wc -c easyeda-bridge-extension/dist/dispatcher.js easyeda-bridge-extension/easyeda-bridge-extension.eext
git diff --stat 18c5217083da7f8a705d8dc246e82fc9ed734caf...HEAD
```

Append only actual results under `## Execution Evidence`.

- [ ] **Step 3: Commit evidence and push final branch**

```bash
git add docs/superpowers/plans/2026-07-23-schematic-transaction-boundary.md
git -c user.name='Osman Aslan' -c user.email='info@oaslananka.dev' \
  commit -m 'docs: record issue 339 completion evidence'
git push -u origin refactor/issue-339-schematic-transactions
```

PR title:

```text
refactor(extension): extract schematic transaction operations
```

PR body may use `Closes #339` only after the rule-check extraction is on `main` and every local gate above passes.

- [ ] **Step 4: Verify all remote checks and review threads**

Required successful checks:

```text
CI Ubuntu/macOS/Windows
Codecov patch checks
Sonar: 0 new issues, 0 accepted issues, 0 hotspots
CodeQL
Semgrep OSS/Cloud
Socket
Trivy
DeepScan
dependency review
container/workflow security
```

Resolve every bot, agent, and human review thread before merge.

- [ ] **Step 5: Merge and verify post-merge main**

After squash merge, verify the exact merge SHA has successful:

```text
CI
Static Security Analysis
Scorecard
Golden Benchmark
Release Please
```

- [ ] **Step 6: Publish final #339 evidence and close only after verification**

The final issue comment must state:

```text
rule-check PR number and merge SHA
transaction PR number and merge SHA
final dispatcher line count and reduction from 5,041 and 3,749 baselines
server and extension test totals
100% coverage evidence for both new modules
67-method parity
bundle/package size results
Sonar/Codecov/security results
post-merge main workflow status
```

If the PR did not close #339 automatically, close it explicitly only after the comment is posted and all acceptance criteria are true.

## Execution Evidence

Populate this section only with command output collected at the exact final PR head and post-merge `main`. Do not estimate values.
