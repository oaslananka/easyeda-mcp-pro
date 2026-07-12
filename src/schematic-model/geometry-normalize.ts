import { createHash } from 'node:crypto';
import { z } from 'zod';

import type {
  AttributeResolution,
  ComponentMetadata,
  RawSchematicSnapshot,
  ResolvedAttribute,
} from './geometry-model.js';

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const boundsSchema = pointSchema.extend({
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
const rawRecordSchema = z.record(z.string(), z.unknown());

const rawPinSchema = z.object({
  runtimePrimitiveId: z.string().min(1).optional(),
  number: z.union([z.string(), z.number()]),
  name: z.string().nullable().optional(),
  electricalType: z.string().nullable().optional(),
  position: pointSchema.nullable().optional(),
  hidden: z.boolean().optional(),
  stacked: z.boolean().optional(),
  stackGroup: z.string().nullable().optional(),
  internallyConnected: z.boolean().optional(),
  powerGroup: z.string().nullable().optional(),
  required: z.boolean().optional(),
  deliberateNoConnect: z.boolean().optional(),
  noConnectAllowed: z.boolean().optional(),
  mechanicallyUnused: z.boolean().optional(),
  pullRequirement: z.enum(['up', 'down', 'either']).nullable().optional(),
  differentialPair: z.string().nullable().optional(),
  differentialPolarity: z.enum(['positive', 'negative']).nullable().optional(),
  unit: z.union([z.string(), z.number()]).nullable().optional(),
  raw: rawRecordSchema.optional(),
});

const rawComponentSchema = z.object({
  runtimePrimitiveId: z.string().min(1),
  reference: z.string().nullable().optional(),
  unit: z.union([z.string(), z.number()]).nullable().optional(),
  componentType: z.string().nullable().optional(),
  symbolSource: z.string().nullable().optional(),
  symbolPrefix: z.string().nullable().optional(),
  deviceName: z.string().nullable().optional(),
  symbolName: z.string().nullable().optional(),
  position: pointSchema.nullable().optional(),
  bounds: boundsSchema.nullable().optional(),
  attributes: rawRecordSchema.optional(),
  resolvedAttributes: rawRecordSchema.optional(),
  pins: z.array(rawPinSchema).optional(),
  dnp: z.boolean().optional(),
  raw: rawRecordSchema.optional(),
});

const rawNetNodeSchema = z.object({
  componentPrimitiveId: z.string().optional(),
  componentReference: z.string().optional(),
  pinNumber: z.union([z.string(), z.number()]).optional(),
  pinPrimitiveId: z.string().optional(),
  position: pointSchema.nullable().optional(),
  raw: rawRecordSchema.optional(),
});

const rawSnapshotSchema = z.object({
  document: z
    .object({
      runtimeDocumentId: z.string().optional(),
      projectId: z.string().optional(),
      documentId: z.string().optional(),
      name: z.string().optional(),
      activeSheetId: z.string().optional(),
      sourceFormat: z.string().optional(),
      generatedAt: z.string().optional(),
    })
    .optional(),
  components: z.array(rawComponentSchema).optional(),
  nets: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().optional(),
        name: z.string().nullable().optional(),
        nodes: z.array(rawNetNodeSchema).optional(),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  wires: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().min(1),
        netName: z.string().nullable().optional(),
        points: z.array(pointSchema).min(1),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  labels: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().min(1),
        netName: z.string(),
        position: pointSchema,
        rotation: z.number().finite().optional(),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  powerSymbols: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().min(1),
        netName: z.string(),
        position: pointSchema.nullable().optional(),
        isPowerFlag: z.boolean().optional(),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  noConnects: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().min(1),
        componentReference: z.string().optional(),
        pinNumber: z.union([z.string(), z.number()]).optional(),
        pinPrimitiveId: z.string().optional(),
        position: pointSchema.nullable().optional(),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  buses: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().min(1),
        name: z.string().optional(),
        members: z.array(z.string()).optional(),
        points: z.array(pointSchema).optional(),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  sheets: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().optional(),
        name: z.string(),
        bounds: boundsSchema.nullable().optional(),
        parentSheetId: z.string().optional(),
        portNames: z.array(z.string()).optional(),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  texts: z
    .array(
      z.object({
        runtimePrimitiveId: z.string().min(1),
        content: z.string(),
        position: pointSchema,
        bounds: boundsSchema.nullable().optional(),
        rotation: z.number().finite().optional(),
        raw: rawRecordSchema.optional(),
      }),
    )
    .optional(),
  unsupportedPrimitives: z
    .array(z.object({ type: z.string(), runtimePrimitiveId: z.string().optional() }))
    .optional(),
});

export class SchematicInputError extends Error {
  readonly code = 'INVALID_ARGUMENT';

  constructor(readonly issues: z.core.$ZodIssue[]) {
    super(`Invalid raw schematic snapshot: ${issues.map((issue) => issue.message).join('; ')}`);
    this.name = 'SchematicInputError';
  }
}

export function parseRawSchematicSnapshot(input: unknown): RawSchematicSnapshot {
  const result = rawSnapshotSchema.safeParse(input);
  if (!result.success) throw new SchematicInputError(result.error.issues);
  return result.data as RawSchematicSnapshot;
}

export function stableCanonicalId(prefix: string, ...parts: unknown[]): string {
  const canonical = parts.map((part) => String(part ?? '')).join('\u001f');
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

export function normalizeLookupKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function lookupRecordValue(
  record: Record<string, unknown>,
  name: string,
): { key: string; value: unknown } | undefined {
  const normalized = normalizeLookupKey(name);
  const entry = Object.entries(record).find(([key]) => normalizeLookupKey(key) === normalized);
  return entry ? { key: entry[0], value: entry[1] } : undefined;
}

const EXPRESSION = /^=\{([^{}]+)\}$/;

function resolveValue(
  value: unknown,
  attributes: Record<string, unknown>,
  resolvedAttributes: Record<string, unknown>,
  visited: Set<string>,
): { resolved?: string; expression?: string; resolution: AttributeResolution } {
  const raw = scalarString(value);
  if (raw === undefined || raw === '') return { resolution: 'missing' };
  const match = raw.match(EXPRESSION);
  if (!match?.[1]) return { resolved: raw, resolution: 'literal' };

  const referencedName = match[1].trim();
  const normalized = normalizeLookupKey(referencedName);
  if (visited.has(normalized)) {
    return { expression: raw, resolution: 'unresolved-expression' };
  }
  visited.add(normalized);

  const explicit = lookupRecordValue(resolvedAttributes, referencedName);
  const referenced = explicit ?? lookupRecordValue(attributes, referencedName);
  if (!referenced) return { expression: raw, resolution: 'unresolved-expression' };
  const nested = resolveValue(referenced.value, attributes, resolvedAttributes, visited);
  if (!nested.resolved) return { expression: raw, resolution: 'unresolved-expression' };
  return { resolved: nested.resolved, expression: raw, resolution: 'resolved-expression' };
}

export function resolveAttribute(
  attributes: Record<string, unknown>,
  resolvedAttributes: Record<string, unknown>,
  aliases: readonly string[],
  fallback?: unknown,
): ResolvedAttribute {
  const entry = aliases
    .map((alias) => lookupRecordValue(attributes, alias))
    .find((candidate) => candidate !== undefined);
  const value = entry?.value ?? fallback;
  const raw = scalarString(value);
  const resolution = resolveValue(value, attributes, resolvedAttributes, new Set());
  return {
    raw,
    resolved: resolution.resolved,
    expression: resolution.expression,
    resolution: resolution.resolution,
  };
}

function booleanAttribute(record: Record<string, unknown>, aliases: readonly string[]): boolean {
  const value = aliases
    .map((alias) => lookupRecordValue(record, alias)?.value)
    .find((candidate) => candidate !== undefined);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return /^(?:1|true|yes|y|dnp|not fitted)$/i.test(value.trim());
  return false;
}

export function resolveComponentMetadata(input: {
  attributes?: Record<string, unknown>;
  resolvedAttributes?: Record<string, unknown>;
  deviceName?: string | null;
  dnp?: boolean;
}): ComponentMetadata {
  const attributes = { ...(input.attributes ?? {}) };
  const resolvedAttributes = { ...(input.resolvedAttributes ?? {}) };
  return {
    value: resolveAttribute(attributes, resolvedAttributes, ['Value', 'Comment', 'Part Value']),
    manufacturerPart: resolveAttribute(attributes, resolvedAttributes, [
      'Manufacturer Part',
      'Manufacturer Part Number',
      'MPN',
    ]),
    lcscNumber: resolveAttribute(attributes, resolvedAttributes, [
      'LCSC',
      'LCSC Part',
      'LCSC Part Number',
      'Supplier Part',
    ]),
    footprint: resolveAttribute(attributes, resolvedAttributes, [
      'Footprint',
      'Package',
      'Package Name',
    ]),
    deviceName: resolveAttribute(
      attributes,
      resolvedAttributes,
      ['Device', 'Device Name', 'Symbol'],
      input.deviceName,
    ),
    description: resolveAttribute(attributes, resolvedAttributes, ['Description', 'Desc']),
    datasheet: resolveAttribute(attributes, resolvedAttributes, ['Datasheet', 'Data Sheet', 'URL']),
    dnp:
      input.dnp === true ||
      booleanAttribute({ ...attributes, ...resolvedAttributes }, [
        'DNP',
        'Do Not Populate',
        'Not Fitted',
      ]),
    rawAttributes: attributes,
  };
}

export function canonicalModelHash(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== 'object') return candidate;
    if (seen.has(candidate)) return '[circular]';
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.map(normalize);
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .filter(([key]) => key !== 'modelHash')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}
