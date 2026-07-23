# Dispatcher API Introspection Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Extract the EasyEDA API path allowlist and runtime result normalization from the 5,041-line extension dispatcher into one stateless, independently tested module without changing any public bridge method or response.

**Architecture:** Create `api-introspection.ts` as a stateless browser-safe module that depends only on `utils.ts`. The dispatcher continues to own toolkit selection, API invocation, inventory assembly, and method routing, but imports typed policy and normalization helpers from the new module. Existing dispatcher integration tests remain the end-to-end parity gate while focused unit tests lock the extracted safety behavior.

**Tech Stack:** TypeScript 6, Vitest 4, esbuild browser IIFE bundle, pnpm 11.5.1, Node.js 24.18.0.

## Global Constraints

- Preserve all 67 extension method names and their sorted order.
- Preserve request/response shapes, error codes, suggestions, and EasyEDA class-name fallback behavior.
- Do not add new EasyEDA features or dependencies.
- Keep `api.execute` quarantine and `api.call` authorization behavior unchanged.
- Keep repeated object references as valid data while representing only active recursion cycles as `[Circular]`.
- Keep the packaged `.eext` under the existing repository size budget.
- Run the exact Node.js 24.18.0 and pnpm 11.5.1 runtime preflight before repository verification.

---

### Task 1: Lock the extracted API safety contract

**Files:**

- Create: `easyeda-bridge-extension/tests/api-introspection.test.ts`
- Test: `easyeda-bridge-extension/tests/dispatcher.test.ts`

**Interfaces:**

- Consumes: existing dispatcher behavior for `api.call` authorization and normalization.
- Produces: executable expectations for `withClassNameVariants`, `normalizeApiClassName`, `isAllowedApiClassName`, `isAllowedApiPath`, `readMember`, `normalizeValue`, `normalizeStandalone`, `readStateValue`, and `compactPrimitiveSummary`.

- [x] **Step 1: Write the failing focused test**

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  compactPrimitiveSummary,
  isAllowedApiClassName,
  isAllowedApiPath,
  normalizeApiClassName,
  normalizeStandalone,
  normalizeValue,
  readMember,
  readStateValue,
  withClassNameVariants,
} from '../src/api-introspection.js';

describe('API introspection policy', () => {
  it('normalizes EasyEDA class prefixes and generates stable variants', () => {
    expect(normalizeApiClassName('sch_PrimitiveWire')).toBe('SCH_PrimitiveWire');
    expect(withClassNameVariants(['sch_PrimitiveWire.getAll', 'SCH_PrimitiveWire.getAll'])).toEqual(
      ['sch_PrimitiveWire.getAll', 'SCH_PrimitiveWire.getAll'],
    );
  });

  it('allows only documented EasyEDA class prefixes and safe method names', () => {
    expect(isAllowedApiClassName('SCH_PrimitiveWire')).toBe(true);
    expect(isAllowedApiPath('sch_PrimitiveWire.getAll')).toBe(true);
    expect(isAllowedApiPath('SYS_Shell.exec')).toBe(false);
    expect(isAllowedApiPath('SCH_PrimitiveWire.constructor')).toBe(false);
    expect(isAllowedApiPath('SCH_PrimitiveWire.__proto__')).toBe(false);
  });

  it('preserves state, methods, repeated references, cycles, and depth bounds', () => {
    const shared = { value: 7 };
    const wrapper = {
      first: shared,
      second: shared,
      getState_PrimitiveId: () => 'wire-1',
      helper() {},
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(normalizeValue(wrapper, 5)).toMatchObject({
      first: { value: 7 },
      second: { value: 7 },
      state: { PrimitiveId: 'wire-1' },
      __methods: expect.arrayContaining(['getState_PrimitiveId', 'helper']),
    });
    expect(normalizeStandalone(cycle, 4)).toEqual({ self: '[Circular]' });
    expect(normalizeStandalone({ nested: { value: 1 } }, 1)).toEqual({ nested: '[MaxDepth]' });
  });

  it('handles throwing members and state getters without escaping the bridge', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = Object.create(null, {
      dangerous: {
        get: () => {
          throw new Error('blocked');
        },
      },
      getState_Name: {
        value: () => {
          throw new Error('state blocked');
        },
      },
    });

    expect(readMember(source, 'dangerous')).toBeUndefined();
    expect(readStateValue(source, 'Name')).toBe('ERROR: Error: state blocked');
    expect(compactPrimitiveSummary(source, ['Name'])).toEqual({
      Name: 'ERROR: Error: state blocked',
    });
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run tests/api-introspection.test.ts
```

Expected: FAIL because `../src/api-introspection.js` does not exist.

- [x] **Step 3: Confirm existing integration behavior remains green before extraction**

Run:

```bash
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run tests/dispatcher.test.ts
```

Expected: 88 dispatcher tests pass.

### Task 2: Extract the stateless policy and normalization module

**Files:**

- Create: `easyeda-bridge-extension/src/api-introspection.ts`
- Modify: `easyeda-bridge-extension/src/dispatcher.ts:9-42,638-802,1176-1240`
- Test: `easyeda-bridge-extension/tests/api-introspection.test.ts`
- Test: `easyeda-bridge-extension/tests/dispatcher.test.ts`

**Interfaces:**

- Consumes: `isRecord`, `logRecoverableError`, and `JsonValue` from `easyeda-bridge-extension/src/utils.ts`.
- Produces:
  - `withClassNameVariants(paths: readonly string[]): string[]`
  - `normalizeApiClassName(className: string): string`
  - `isAllowedApiClassName(className: string): boolean`
  - `isAllowedApiPath(path: string): boolean`
  - `getFunctionNames(value: unknown): string[]`
  - `readMember(source: unknown, key: string): unknown`
  - `normalizeValue(value: unknown, depth?: number, seen?: WeakSet<object>): JsonValue`
  - `normalizeStandalone(value: unknown, depth?: number): JsonValue`
  - `readStateValue(source: unknown, stateName: string, depth?: number): JsonValue | undefined`
  - `compactPrimitiveSummary(value: unknown, stateNames: readonly string[]): Record<string, JsonValue | undefined>`

- [x] **Step 1: Implement the stateless module**

```ts
import { isRecord, logRecoverableError, type JsonValue } from './utils.js';

const API_CLASS_PREFIXES = ['DMT_', 'SCH_', 'PCB_', 'LIB_'] as const;
const DENIED_API_METHODS = new Set([
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
]);

export function withClassNameVariants(paths: readonly string[]): string[] {
  const variants: string[] = [];
  for (const path of paths) {
    variants.push(path);
    const parts = path.split('.');
    const className = parts[0];
    if (!className) continue;
    const suffix = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '';
    const lower = /^([a-z]+)_(.+)$/.exec(className);
    const upper = /^([A-Z]+)_(.+)$/.exec(className);
    if (lower?.[1] && lower[2]) variants.push(`${lower[1].toUpperCase()}_${lower[2]}${suffix}`);
    if (upper?.[1] && upper[2]) variants.push(`${upper[1].toLowerCase()}_${upper[2]}${suffix}`);
  }
  return [...new Set(variants)];
}

export function normalizeApiClassName(className: string): string {
  const match = /^([a-z]+)_(.+)$/.exec(className);
  return match?.[1] && match[2] ? `${match[1].toUpperCase()}_${match[2]}` : className;
}

export function isAllowedApiClassName(className: string): boolean {
  const normalized = normalizeApiClassName(className);
  return API_CLASS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isAllowedApiPath(path: string): boolean {
  const parts = path.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [className, methodName] = parts;
  if (DENIED_API_METHODS.has(methodName) || methodName.startsWith('__')) return false;
  if (!/^[A-Za-z]+_[A-Za-z0-9]+$/.test(className)) return false;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(methodName)) return false;
  return isAllowedApiClassName(className);
}

function getAllPropertyNames(value: unknown): string[] {
  const names: string[] = [];
  let cursor = value;
  let depth = 0;
  while (isRecord(cursor) && cursor !== Object.prototype && depth < 8) {
    try {
      names.push(...Object.getOwnPropertyNames(cursor));
    } catch (error) {
      logRecoverableError('failed to read API property names', error);
      break;
    }
    try {
      cursor = Object.getPrototypeOf(cursor);
    } catch (error) {
      logRecoverableError('failed to read API property prototype', error);
      break;
    }
    depth += 1;
  }
  return [...new Set(names)].filter(
    (name) => !['length', 'name', 'prototype', 'constructor'].includes(name),
  );
}

export function readMember(source: unknown, key: string): unknown {
  if (!isRecord(source) || !(key in source)) return undefined;
  try {
    return source[key];
  } catch (error) {
    logRecoverableError(`failed to read API member ${key}`, error);
    return undefined;
  }
}

export function getFunctionNames(value: unknown): string[] {
  return getAllPropertyNames(value).filter((name) => typeof readMember(value, name) === 'function');
}

export function normalizeValue(value: unknown, depth = 3, seen = new WeakSet<object>()): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (value === undefined) return null;
  if (typeof value === 'function') return `[Function ${value.name ?? 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth <= 0) return '[MaxDepth]';

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeValue(item, depth - 1, seen));
    const output: Record<string, JsonValue | undefined> = {};
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== 'Object') output.__class = ctorName;
    const getterNames = getFunctionNames(value).filter((name) => name.startsWith('getState_'));
    if (getterNames.length) {
      const state: Record<string, JsonValue | undefined> = {};
      for (const getterName of getterNames) {
        const getter = readMember(value, getterName);
        if (typeof getter !== 'function') continue;
        try {
          state[getterName.replace(/^getState_/, '')] = normalizeValue(
            getter.call(value),
            depth - 1,
            seen,
          );
        } catch (error) {
          state[getterName.replace(/^getState_/, '')] = `ERROR: ${String(error)}`;
        }
      }
      output.state = state;
    }
    const methodNames = getFunctionNames(value);
    if (methodNames.length) output.__methods = methodNames;
    for (const key of Object.keys(value)) {
      output[key] = normalizeValue((value as Record<string, unknown>)[key], depth - 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function normalizeStandalone(value: unknown, depth = 4): JsonValue {
  return normalizeValue(value, depth, new WeakSet<object>());
}

export function readStateValue(
  source: unknown,
  stateName: string,
  depth = 4,
): JsonValue | undefined {
  const getter = readMember(source, `getState_${stateName}`);
  if (typeof getter !== 'function') return undefined;
  try {
    return normalizeStandalone(getter.call(source), depth);
  } catch (error) {
    return `ERROR: ${String(error)}`;
  }
}

export function compactPrimitiveSummary(
  value: unknown,
  stateNames: readonly string[],
): Record<string, JsonValue | undefined> {
  const state: Record<string, JsonValue | undefined> = {};
  for (const stateName of stateNames) state[stateName] = readStateValue(value, stateName, 5);
  return state;
}
```

- [x] **Step 2: Replace dispatcher-local helpers with imports**

Add this import to `dispatcher.ts`:

```ts
import {
  compactPrimitiveSummary,
  getFunctionNames,
  isAllowedApiClassName,
  isAllowedApiPath,
  normalizeApiClassName,
  normalizeStandalone,
  normalizeValue,
  readMember,
  readStateValue,
  withClassNameVariants,
} from './api-introspection.js';
```

Delete the dispatcher-local API prefix constants and helper implementations. In `inspectApiInventory`, replace the direct prefix-array predicate with:

```ts
if (!isAllowedApiClassName(className)) continue;
```

- [x] **Step 3: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @easyeda-mcp-pro/bridge-extension exec vitest run \
  tests/api-introspection.test.ts tests/dispatcher.test.ts
pnpm --filter @easyeda-mcp-pro/bridge-extension typecheck
```

Expected: focused module tests and all 88 dispatcher integration tests pass; TypeScript reports zero errors.

- [x] **Step 4: Commit the extraction**

```bash
git add easyeda-bridge-extension/src/api-introspection.ts \
  easyeda-bridge-extension/src/dispatcher.ts \
  easyeda-bridge-extension/tests/api-introspection.test.ts
git commit -m "refactor(extension): extract API introspection policy"
```

### Task 3: Prove behavior and package parity

**Files:**

- Modify: `docs/superpowers/plans/2026-07-23-dispatcher-api-introspection-extraction.md`
- Verify: `easyeda-bridge-extension/dist/dispatcher.meta.json`
- Verify: `easyeda-bridge-extension/easyeda-bridge-extension.eext`
- Verify: `tests/unit/extension/method-list-parity.test.ts`
- Verify: `tests/unit/repository/extension-size-budget.test.ts`

**Interfaces:**

- Consumes: the extraction implemented in Task 2.
- Produces: PR-ready evidence that the refactor preserves public methods, dispatcher behavior, and package limits.

- [x] **Step 1: Run extension coverage and package checks**

Run:

```bash
pnpm test:extension:ci
pnpm build:extension
pnpm check:extension-size
pnpm vitest run tests/unit/extension/method-list-parity.test.ts \
  tests/unit/repository/extension-size-budget.test.ts
```

Expected: all extension tests and coverage pass; the package is generated; method-list parity and size-budget tests pass.

- [x] **Step 2: Run complete repository verification**

Run:

```bash
pnpm verify
```

Expected: runtime preflight, format, root and extension typecheck, lint, metadata/profile checks, server tests, extension tests, builds, package checks, generated compatibility validation, and docs build all pass.

- [x] **Step 3: Record objective parity evidence for the PR**

Run:

```bash
wc -l easyeda-bridge-extension/src/dispatcher.ts
node -e "const m=require('./easyeda-bridge-extension/dist/dispatcher.meta.json'); console.log(JSON.stringify({buildId:m.buildId,byteLength:m.byteLength}))"
git diff --check
git status --short --branch
```

Expected: dispatcher line count decreases; the bundle remains under the repository budget; only planned source, test, and plan files are changed.

- [x] **Step 4: Commit the implementation plan and evidence updates**

```bash
git add docs/superpowers/plans/2026-07-23-dispatcher-api-introspection-extraction.md
git commit -m "docs(plan): record dispatcher extraction strategy"
```

## Execution evidence

- TDD RED: the focused test failed because `src/api-introspection.ts` did not exist; the existing dispatcher integration baseline remained 88/88 green.
- Focused parity: 9 API-introspection tests and all 89 dispatcher integration tests pass.
- Extracted-module coverage: 100% statements, branches, functions, and lines in the full extension coverage run.
- Public method contract: the extension still reports the same 67 sorted bridge methods; the repository method-list parity test passes.
- Dispatcher source size: 5,041 lines on `main` → 4,878 lines after extraction (163-line reduction).
- Built dispatcher bundle: 151,308 bytes on `main` → 151,841 bytes (+533 bytes, approximately +0.35%).
- Packaged extension: 160,515 bytes on `main` → 160,594 bytes (+79 bytes, approximately +0.05%); the repository size budget passes.
- Full extension suite: 10 files / 153 tests pass.
- Sonar follow-up: the initial PR scan reported three new issues (regex style, cognitive complexity, and ambiguous scalar stringification); the normalization flow was split into bounded helpers and bigint/symbol conversion was made explicit before the final verification run.
- Codecov follow-up: the initial patch report identified the delegated `system.apiInventory` allowlist line as uncovered; a dispatcher contract test now proves both allowed-class inclusion and `SYS_*` exclusion (`DA:1030=160`, branches `159/1`).
- Full server suite: 150 files / 1,740 tests pass.
- Full `pnpm verify` passes runtime preflight, formatting, root and extension typecheck, ESLint, tool/profile metadata, server and extension tests, both builds, extension packaging/checksums, metadata alignment, generated compatibility validation, and VitePress documentation.
