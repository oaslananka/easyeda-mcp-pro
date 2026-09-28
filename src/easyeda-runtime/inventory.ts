import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { type BridgeManager } from '../bridge/manager.js';
import { type BridgeHello } from '../bridge/protocol.js';

export const RUNTIME_INVENTORY_SCHEMA_VERSION = 1;

export const RuntimeInventoryClassSchema = z.object({
  className: z.string().min(1),
  runtimePaths: z.array(z.string()).default([]),
  methods: z.array(z.string()).default([]),
});

export const RuntimeInventorySnapshotSchema = z.object({
  schemaVersion: z.literal(RUNTIME_INVENTORY_SCHEMA_VERSION),
  generatedAt: z.string(),
  filter: z.string().optional(),
  easyedaVersion: z.string().optional(),
  bridgeVersion: z.string().optional(),
  methodRegistryHash: z.string().optional(),
  total: z.number().int().nonnegative(),
  classes: z.array(RuntimeInventoryClassSchema),
});

export type RuntimeInventoryClass = z.infer<typeof RuntimeInventoryClassSchema>;
export type RuntimeInventorySnapshot = z.infer<typeof RuntimeInventorySnapshotSchema> & {
  /**
   * Internal compatibility marker used when a legacy snapshot did not record runtime paths.
   * It is intentionally not part of the persisted v1 schema.
   */
  runtimePathsComplete?: boolean;
};

export interface RuntimeInventoryCaptureConfig {
  enabled: boolean;
  filter?: string;
  outputPath: string;
  timeoutMs: number;
}

export interface RuntimeInventoryClassDiff {
  className: string;
  addedRuntimePaths: string[];
  removedRuntimePaths: string[];
  addedMethods: string[];
  removedMethods: string[];
}

export interface RuntimeInventoryDiff {
  status: 'same' | 'changed';
  baseTotal: number;
  currentTotal: number;
  addedClasses: RuntimeInventoryClass[];
  removedClasses: RuntimeInventoryClass[];
  changedClasses: RuntimeInventoryClassDiff[];
  summary: {
    addedClasses: number;
    removedClasses: number;
    changedClasses: number;
    addedMethods: number;
    removedMethods: number;
  };
}

const LegacyRuntimeInventoryClassSchema = z.object({
  className: z.string().min(1),
  runtimePaths: z.array(z.string()).optional(),
  methods: z.array(z.string()).default([]),
});

const LegacyRuntimeInventorySnapshotSchema = z
  .object({
    generatedAt: z.string().optional(),
    filter: z.string().optional(),
    easyedaVersion: z.string().optional(),
    easyedaShellVersion: z.string().optional(),
    bridgeVersion: z.string().optional(),
    methodRegistryHash: z.string().optional(),
    total: z.number().int().nonnegative(),
    classes: z.array(LegacyRuntimeInventoryClassSchema),
  })
  .passthrough();

interface InventoryBridgeResponse {
  classes: RuntimeInventoryClass[];
  total: number;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(
    new Set(values.filter((value) => value.trim()).map((value) => value.trim())),
  ).sort((left, right) => left.localeCompare(right, 'en'));
}

export function normalizeRuntimeInventoryClasses(
  classes: RuntimeInventoryClass[],
): RuntimeInventoryClass[] {
  return classes
    .map((entry) => ({
      className: entry.className.trim(),
      runtimePaths: sortedUnique(entry.runtimePaths),
      methods: sortedUnique(entry.methods),
    }))
    .filter((entry) => entry.className.length > 0)
    .sort((a, b) => a.className.localeCompare(b.className));
}

export function createRuntimeInventorySnapshot(input: {
  classes: RuntimeInventoryClass[];
  filter?: string;
  hello?: BridgeHello | null;
  methodRegistryHash?: string;
  generatedAt?: string;
}): RuntimeInventorySnapshot {
  const classes = normalizeRuntimeInventoryClasses(input.classes);
  return RuntimeInventorySnapshotSchema.parse({
    schemaVersion: RUNTIME_INVENTORY_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    filter: input.filter || undefined,
    easyedaVersion: input.hello?.easyedaVersion,
    bridgeVersion: input.hello?.bridgeVersion,
    methodRegistryHash: input.hello?.methodRegistryHash ?? input.methodRegistryHash,
    total: classes.length,
    classes,
  });
}

export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function parseRuntimeInventoryCaptureConfig(
  env: Record<string, string | undefined>,
): RuntimeInventoryCaptureConfig {
  return {
    enabled: parseBooleanEnv(env.EASYEDA_RUNTIME_INVENTORY_CAPTURE),
    filter: env.EASYEDA_RUNTIME_INVENTORY_FILTER?.trim() || undefined,
    outputPath:
      env.EASYEDA_RUNTIME_INVENTORY_PATH?.trim() ||
      '.easyeda-mcp-pro/runtime-inventory/latest.json',
    timeoutMs: Number.parseInt(env.EASYEDA_RUNTIME_INVENTORY_TIMEOUT_MS ?? '30000', 10),
  };
}

export function validateRuntimeInventoryCaptureConfig(
  config: RuntimeInventoryCaptureConfig,
): string[] {
  const errors: string[] = [];
  if (
    !Number.isFinite(config.timeoutMs) ||
    config.timeoutMs < 1_000 ||
    config.timeoutMs > 120_000
  ) {
    errors.push('EASYEDA_RUNTIME_INVENTORY_TIMEOUT_MS must be between 1000 and 120000.');
  }
  return errors;
}

export async function captureRuntimeInventorySnapshot(
  bridge: Pick<BridgeManager, 'connect' | 'disconnect' | 'call' | 'hello' | 'methodRegistryHash'>,
  config: RuntimeInventoryCaptureConfig,
): Promise<RuntimeInventorySnapshot | null> {
  if (!config.enabled) return null;
  const errors = validateRuntimeInventoryCaptureConfig(config);
  if (errors.length > 0) throw new Error(errors.join(' '));

  await bridge.connect();
  try {
    const response = await bridge.call<{ filter?: string }, InventoryBridgeResponse>(
      'system.apiInventory',
      { filter: config.filter },
      { timeoutMs: config.timeoutMs },
    );
    return createRuntimeInventorySnapshot({
      classes: response.classes,
      filter: config.filter,
      hello: bridge.hello as BridgeHello | null,
      methodRegistryHash: bridge.methodRegistryHash,
    });
  } finally {
    bridge.disconnect('runtime inventory capture complete');
  }
}

function mapByClassName(snapshot: RuntimeInventorySnapshot): Map<string, RuntimeInventoryClass> {
  return new Map(snapshot.classes.map((entry) => [entry.className, entry]));
}

function difference(current: string[], base: string[]): string[] {
  const baseSet = new Set(base);
  return current.filter((value) => !baseSet.has(value));
}

export function diffRuntimeInventorySnapshots(
  base: RuntimeInventorySnapshot,
  current: RuntimeInventorySnapshot,
): RuntimeInventoryDiff {
  const normalizedBase = {
    ...base,
    total: normalizeRuntimeInventoryClasses(base.classes).length,
    classes: normalizeRuntimeInventoryClasses(base.classes),
  };
  const normalizedCurrent = {
    ...current,
    total: normalizeRuntimeInventoryClasses(current.classes).length,
    classes: normalizeRuntimeInventoryClasses(current.classes),
  };
  const compareRuntimePaths =
    normalizedBase.runtimePathsComplete !== false &&
    normalizedCurrent.runtimePathsComplete !== false;
  const baseMap = mapByClassName(normalizedBase);
  const currentMap = mapByClassName(normalizedCurrent);

  const addedClasses = normalizedCurrent.classes.filter((entry) => !baseMap.has(entry.className));
  const removedClasses = normalizedBase.classes.filter((entry) => !currentMap.has(entry.className));
  const changedClasses: RuntimeInventoryClassDiff[] = [];

  for (const [className, currentEntry] of currentMap) {
    const baseEntry = baseMap.get(className);
    if (!baseEntry) continue;
    const classDiff = {
      className,
      addedRuntimePaths: compareRuntimePaths
        ? difference(currentEntry.runtimePaths, baseEntry.runtimePaths)
        : [],
      removedRuntimePaths: compareRuntimePaths
        ? difference(baseEntry.runtimePaths, currentEntry.runtimePaths)
        : [],
      addedMethods: difference(currentEntry.methods, baseEntry.methods),
      removedMethods: difference(baseEntry.methods, currentEntry.methods),
    };
    if (
      classDiff.addedRuntimePaths.length > 0 ||
      classDiff.removedRuntimePaths.length > 0 ||
      classDiff.addedMethods.length > 0 ||
      classDiff.removedMethods.length > 0
    ) {
      changedClasses.push(classDiff);
    }
  }

  const summary = {
    addedClasses: addedClasses.length,
    removedClasses: removedClasses.length,
    changedClasses: changedClasses.length,
    addedMethods: changedClasses.reduce((sum, entry) => sum + entry.addedMethods.length, 0),
    removedMethods: changedClasses.reduce((sum, entry) => sum + entry.removedMethods.length, 0),
  };

  const status =
    summary.addedClasses === 0 &&
    summary.removedClasses === 0 &&
    summary.changedClasses === 0 &&
    summary.addedMethods === 0 &&
    summary.removedMethods === 0
      ? 'same'
      : 'changed';

  return {
    status,
    baseTotal: normalizedBase.total,
    currentTotal: normalizedCurrent.total,
    addedClasses,
    removedClasses,
    changedClasses,
    summary,
  };
}

export async function readRuntimeInventorySnapshot(
  path: string,
): Promise<RuntimeInventorySnapshot> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const current = RuntimeInventorySnapshotSchema.safeParse(raw);
  if (current.success) return current.data;

  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.prototype.hasOwnProperty.call(raw, 'schemaVersion')
  ) {
    return RuntimeInventorySnapshotSchema.parse(raw);
  }

  const legacy = LegacyRuntimeInventorySnapshotSchema.parse(raw);
  const runtimePathsComplete = legacy.classes.every((entry) => entry.runtimePaths !== undefined);
  const classes = legacy.classes.map((entry) => ({
    className: entry.className,
    runtimePaths: entry.runtimePaths ?? [],
    methods: entry.methods,
  }));

  return {
    schemaVersion: RUNTIME_INVENTORY_SCHEMA_VERSION,
    generatedAt: legacy.generatedAt ?? 'legacy-unspecified',
    filter: legacy.filter,
    easyedaVersion: legacy.easyedaVersion ?? legacy.easyedaShellVersion,
    bridgeVersion: legacy.bridgeVersion,
    methodRegistryHash: legacy.methodRegistryHash,
    total: classes.length,
    classes: normalizeRuntimeInventoryClasses(classes),
    runtimePathsComplete,
  };
}

export async function writeRuntimeInventorySnapshot(
  path: string,
  snapshot: RuntimeInventorySnapshot,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(RuntimeInventorySnapshotSchema.parse(snapshot), null, 2)}\n`,
    'utf8',
  );
}

export async function writeRuntimeInventoryDiff(
  path: string,
  diff: RuntimeInventoryDiff,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
}
