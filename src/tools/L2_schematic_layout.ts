import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import {
  evaluateSchematicLayoutQa,
  type ExpectedPinMapping,
  type LayoutQaBounds,
  type LayoutQaInput,
  type LayoutQaPrimitive,
  type LayoutQaRelationship,
  type LayoutQaResult,
  type LayoutQaWire,
  type RuntimeDiagnostic,
  type VisualHeuristicFinding,
} from '../workflows/schematic-layout-qa.js';
import {
  defaultTitleBlockKeepout,
  inferSchematicSheetGeometry,
} from '../workflows/schematic-safe-region.js';
import { createConnectivityFingerprint } from '../schematic-model/connectivity-fingerprint.js';
import { buildSchematicModel } from '../schematic-model/model-builder.js';
import { gatherLiveSchematicSnapshot } from '../schematic-model/live-snapshot.js';
import { gatherLivePrimitiveBounds } from '../schematic-model/live-primitive-bounds.js';
import { type ToolContext, type ToolDefinition } from './types.js';

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const expectedPinSchema = z.object({
  componentRef: z.string().min(1),
  pin: z.string().min(1),
  netName: z.string().min(1),
});

const relationshipSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  kind: z.enum(['decoupling', 'protection', 'support', 'signal-flow', 'custom']),
  maxDistance: z.number().positive(),
});

const visualFindingSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string().min(1),
  confidence: z.number().min(0).max(1),
  affectedPrimitiveIds: z.array(z.string()).optional(),
  region: boundsSchema.optional(),
  remediation: z.string().min(1),
});

const qaIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['critical', 'error', 'warning', 'info']),
  category: z.enum(['electrical', 'geometry', 'readability', 'grouping', 'wiring', 'runtime']),
  source: z.enum([
    'exact_geometry',
    'derived_geometry',
    'runtime_drc',
    'runtime_erc',
    'expected_topology',
    'connectivity_fingerprint',
    'visual_heuristic',
    'runtime_capability',
  ]),
  message: z.string(),
  affectedPrimitiveIds: z.array(z.string()),
  affectedNets: z.array(z.string()),
  affectedPins: z.array(z.string()),
  region: boundsSchema.optional(),
  measured: z.number().optional(),
  expected: z.union([z.number(), z.string()]).optional(),
  evidence: z.string(),
  remediation: z.string(),
  blocksCommit: z.boolean(),
  confidence: z.number().min(0).max(1),
});

const connectivityFingerprintOutputSchema = z.object({
  projectId: z.string(),
  schemaVersion: z.literal(1),
  hash: z.string(),
  modelHash: z.string(),
  componentCount: z.number().int().nonnegative(),
  netCount: z.number().int().nonnegative(),
  normalized: z.object({
    pinNetMembership: z.array(
      z.object({
        componentId: z.string(),
        componentReference: z.string(),
        pinId: z.string(),
        pinNumber: z.string(),
        netIds: z.array(z.string()),
      }),
    ),
    wireEndpoints: z.array(
      z.object({
        wireId: z.string(),
        netId: z.string().optional(),
        netName: z.string().optional(),
        endpoints: z.array(
          z.object({
            endpoint: z.enum(['start', 'end']),
            kind: z.enum(['pin', 'unresolved']),
            token: z.string(),
          }),
        ),
      }),
    ),
    labelsAndPorts: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(['label', 'sheet-port', 'power-symbol']),
        netName: z.string(),
      }),
    ),
    noConnects: z.array(
      z.object({
        noConnectId: z.string(),
        componentReference: z.string().optional(),
        pinId: z.string().optional(),
        pinNumber: z.string().optional(),
      }),
    ),
  }),
  diagnosticCount: z.number().int().nonnegative(),
});

const primitiveBoundsSegmentSchema = z.object({
  id: z.string().optional(),
  bounds: boundsSchema,
  geometrySource: z.enum(['runtime', 'derived', 'approximate']),
  confidence: z.enum(['exact', 'conservative', 'low']),
});

const primitiveBoundsItemSchema = z.object({
  id: z.string(),
  primitiveType: z.string(),
  origin: z.object({ x: z.number(), y: z.number() }),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  mirroredX: z.boolean(),
  mirroredY: z.boolean(),
  units: z.string(),
  grid: z.number(),
  coordinateOrigin: z.object({
    x: z.number(),
    y: z.number(),
    yAxis: z.enum(['up', 'down']),
    source: z.enum(['runtime', 'live-readback', 'derived']),
  }),
  availability: z.enum(['available', 'not_available']),
  geometrySource: z.enum(['runtime', 'derived', 'approximate', 'not_available']),
  confidence: z.enum(['exact', 'conservative', 'low', 'not_available']),
  body: primitiveBoundsSegmentSchema.optional(),
  reference: primitiveBoundsSegmentSchema.optional(),
  value: primitiveBoundsSegmentSchema.optional(),
  pinTexts: z.array(primitiveBoundsSegmentSchema),
  labels: z.array(primitiveBoundsSegmentSchema),
  annotations: z.array(primitiveBoundsSegmentSchema),
  combinedBounds: boundsSchema.optional(),
  limitations: z.array(z.string()),
});

const primitiveBoundsOutputSchema = z.object({
  items: z.array(primitiveBoundsItemSchema),
  availableCount: z.number().int().nonnegative(),
  notAvailableCount: z.number().int().nonnegative(),
  units: z.string(),
  coordinateOrigins: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      yAxis: z.enum(['up', 'down']),
      source: z.enum(['runtime', 'live-readback', 'derived']),
    }),
  ),
});

export const layoutQaOutputSchema = z.object({
  projectId: z.string(),
  status: z.enum(['pass', 'fail', 'inconclusive']),
  passed: z.boolean(),
  commitBlocked: z.boolean(),
  issues: z.array(qaIssueSchema),
  issueCounts: z.object({
    critical: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  scores: z.object({
    geometry: z.number().min(0).max(100),
    readability: z.number().min(0).max(100),
    grouping: z.number().min(0).max(100),
    spacing: z.number().min(0).max(100),
    wiring: z.number().min(0).max(100),
    electrical: z.number().min(0).max(100),
    runtime: z.number().min(0).max(100),
    overall: z.number().min(0).max(100),
  }),
  evidence: z.object({
    exactGeometry: z.boolean(),
    runtimeDrc: z.boolean(),
    runtimeErc: z.boolean(),
    fullPageCapture: z.boolean(),
    deterministicCapture: z.boolean(),
  }),
  summary: z.object({
    criticalIssueCodes: z.array(z.string()),
    blockingIssueCodes: z.array(z.string()),
    topIssues: z.array(qaIssueSchema),
  }),
});

export interface CollectSchematicLayoutQaOptions {
  expectedComponentRefs?: string[];
  expectedNetNames?: string[];
  expectedPinMappings?: ExpectedPinMapping[];
  relationships?: LayoutQaRelationship[];
  connectivity?: LayoutQaInput['connectivity'];
  thresholds?: LayoutQaInput['thresholds'];
  visualFindings?: VisualHeuristicFinding[];
  runVisualCapture?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function bounds(value: unknown): LayoutQaBounds | undefined {
  const item = record(value);
  const x = numberValue(item.x ?? item.left);
  const y = numberValue(item.y ?? item.bottom);
  const width = numberValue(item.width);
  const height = numberValue(item.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    const right = numberValue(item.right);
    const top = numberValue(item.top);
    if (x === undefined || y === undefined || right === undefined || top === undefined)
      return undefined;
    return { x, y, width: right - x, height: top - y };
  }
  return { x, y, width, height };
}

function boundsArray(value: unknown): LayoutQaBounds[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(bounds).filter((item): item is LayoutQaBounds => Boolean(item));
  return parsed.length > 0 ? parsed : undefined;
}

function normalizePrimitiveType(value: unknown): LayoutQaPrimitive['primitiveType'] {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('netport') || normalized.includes('net-port')) return 'netport';
  if (normalized.includes('section') || normalized.includes('rectangle')) return 'section';
  if (normalized.includes('annotation')) return 'annotation';
  if (normalized.includes('label')) return 'label';
  if (normalized.includes('text')) return 'text';
  return 'component';
}

function normalizeGeometrySource(value: unknown): LayoutQaPrimitive['geometrySource'] {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'runtime') return 'runtime';
  if (normalized === 'approximate') return 'approximate';
  if (normalized === 'not_available') return 'not_available';
  return 'derived';
}

function primitiveItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const root = record(result);
  for (const key of ['items', 'primitives', 'bounds', 'results']) {
    if (Array.isArray(root[key])) return root[key];
  }
  return [];
}

function normalizePrimitive(itemValue: unknown): LayoutQaPrimitive | undefined {
  const item = record(itemValue);
  const combined = bounds(item.combinedBounds ?? item.combined_bounds ?? item.bounds);
  const id = stringValue(item.id ?? item.primitiveId ?? item.primitive_id);
  if (!combined || !id) return undefined;
  return {
    id,
    primitiveType: normalizePrimitiveType(item.primitiveType ?? item.primitive_type ?? item.type),
    ref: stringValue(item.ref ?? item.reference ?? item.designator),
    netName: stringValue(item.netName ?? item.net_name ?? item.net),
    blockId: stringValue(item.blockId ?? item.block_id),
    combinedBounds: combined,
    bodyBounds: bounds(item.bodyBounds ?? item.body_bounds),
    referenceBounds: bounds(item.referenceBounds ?? item.reference_bounds),
    valueBounds: bounds(item.valueBounds ?? item.value_bounds),
    pinTextBounds: boundsArray(item.pinTextBounds ?? item.pin_text_bounds),
    labelBounds: boundsArray(item.labelBounds ?? item.label_bounds),
    annotationBounds: boundsArray(item.annotationBounds ?? item.annotation_bounds),
    connected: booleanValue(item.connected),
    rotation: numberValue(item.rotation),
    geometrySource: normalizeGeometrySource(item.geometrySource ?? item.geometry_source),
  };
}

function normalizeWires(result: unknown): LayoutQaWire[] {
  const root = record(result);
  const items = Array.isArray(result)
    ? result
    : Array.isArray(root.samples)
      ? root.samples
      : Array.isArray(root.items)
        ? root.items
        : [];
  return items.flatMap((value, index) => {
    const item = record(value);
    const id = stringValue(item.primitiveId ?? item.primitive_id ?? item.id) ?? `wire-${index + 1}`;
    const rawLine = Array.isArray(item.line) ? item.line : [];
    const points: Array<{ x: number; y: number }> = [];
    for (let pointIndex = 0; pointIndex + 1 < rawLine.length; pointIndex += 2) {
      const x = numberValue(rawLine[pointIndex]);
      const y = numberValue(rawLine[pointIndex + 1]);
      if (x !== undefined && y !== undefined) points.push({ x, y });
    }
    return [
      {
        id,
        netName: stringValue(item.netName ?? item.net_name ?? item.net),
        points,
        length: numberValue(item.length),
        connectedEndpointCount: numberValue(item.connectedEndpointCount),
      },
    ];
  });
}

function netPinMap(result: unknown): Map<string, Array<{ pin: string; netName: string }>> {
  const root = record(result);
  const nets = Array.isArray(result) ? result : Array.isArray(root.nets) ? root.nets : [];
  const map = new Map<string, Array<{ pin: string; netName: string }>>();
  for (const netValue of nets) {
    const net = record(netValue);
    const netName = stringValue(net.netName ?? net.net_name ?? net.name);
    if (!netName || !Array.isArray(net.nodes)) continue;
    for (const nodeValue of net.nodes) {
      const node = record(nodeValue);
      const ref = stringValue(node.component ?? node.componentRef ?? node.component_ref);
      const pin = stringValue(node.pin ?? node.pinNumber ?? node.pin_number);
      if (!ref || !pin) continue;
      map.set(ref, [...(map.get(ref) ?? []), { pin, netName }]);
    }
  }
  return map;
}

function normalizeDiagnostics(result: unknown, source: 'DRC' | 'ERC'): RuntimeDiagnostic[] {
  const root = record(result);
  const raw = Array.isArray(root.violations) ? root.violations : [];
  const diagnostics = raw.map((value): RuntimeDiagnostic => {
    const item = record(value);
    const severityValue = String(item.severity ?? item.type ?? '').toLowerCase();
    const severity: RuntimeDiagnostic['severity'] =
      severityValue.includes('fatal') || severityValue.includes('critical')
        ? 'critical'
        : severityValue.includes('error')
          ? 'error'
          : severityValue.includes('warn')
            ? 'warning'
            : 'info';
    return {
      id: stringValue(item.id ?? item.rule),
      message:
        stringValue(item.description ?? item.message) ??
        `${source} returned an unspecified finding.`,
      severity,
      componentId: stringValue(item.component ?? item.primitiveId),
      netName: stringValue(item.net ?? item.netName),
    };
  });
  const total =
    numberValue(root.totalViolations ?? root.total_violations) ??
    numberValue(root.errorCount ?? root.error_count) ??
    diagnostics.length;
  if (total > diagnostics.length) {
    diagnostics.push({
      message: `${source} reported ${total} finding(s), but only ${diagnostics.length} had structured details.`,
      severity: 'warning',
      classification: 'runtime_limitation',
    });
  }
  return diagnostics;
}

async function optionalBridgeCall(
  ctx: ToolContext,
  method: Parameters<ToolContext['bridge']['call']>[0],
  params: Record<string, unknown>,
): Promise<{ available: boolean; result?: unknown; error?: string }> {
  try {
    return { available: true, result: await ctx.bridge.call(method, params) };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectSchematicLayoutQa(
  ctx: ToolContext,
  projectId: string,
  options: CollectSchematicLayoutQaOptions = {},
): Promise<LayoutQaResult> {
  const sheetRead = await optionalBridgeCall(ctx, 'schematic.getSheetInfo', { projectId });
  const sheet = inferSchematicSheetGeometry(sheetRead.result);
  const margin = Math.max(10, Math.min(sheet.width, sheet.height) * 0.025);
  const pageBounds: LayoutQaBounds = { x: 0, y: 0, width: sheet.width, height: sheet.height };
  const drawableBounds: LayoutQaBounds = {
    x: margin,
    y: margin,
    width: Math.max(0, sheet.width - margin * 2),
    height: Math.max(0, sheet.height - margin * 2),
  };

  const [boundsRead, netsRead, wiresRead, drcRead, ercRead] = await Promise.all([
    optionalBridgeCall(ctx, 'schematic.primitiveBounds', { projectId }),
    optionalBridgeCall(ctx, 'schematic.listNets', { projectId }),
    optionalBridgeCall(ctx, 'system.inspectWires', { projectId, limit: 10_000, offset: 0 }),
    optionalBridgeCall(ctx, 'design.drc', { projectId }),
    optionalBridgeCall(ctx, 'design.erc', { projectId }),
  ]);

  const pinsByRef = netPinMap(netsRead.result);
  const primitives = primitiveItems(boundsRead.result)
    .map(normalizePrimitive)
    .filter((item): item is LayoutQaPrimitive => Boolean(item))
    .map((primitive) => {
      const pins = primitive.ref ? pinsByRef.get(primitive.ref) : undefined;
      return pins
        ? {
            ...primitive,
            pinConnections: pins.map((pin) => ({ ...pin, connected: true })),
          }
        : primitive;
    });

  let captureAvailable = false;
  if (options.runVisualCapture ?? true) {
    const capture = await optionalBridgeCall(ctx, 'canvas.captureRegion', {
      left: pageBounds.x,
      right: pageBounds.x + pageBounds.width,
      top: pageBounds.y + pageBounds.height,
      bottom: pageBounds.y,
      clearSelection: true,
    });
    captureAvailable = capture.available && Boolean(record(capture.result).base64);
  }

  return evaluateSchematicLayoutQa({
    projectId,
    sheet: {
      pageBounds,
      drawableBounds,
      titleBlockKeepout: defaultTitleBlockKeepout(sheet),
    },
    primitives,
    wires: normalizeWires(wiresRead.result),
    relationships: options.relationships,
    expected: {
      componentRefs: options.expectedComponentRefs,
      netNames: options.expectedNetNames,
      pinMappings: options.expectedPinMappings,
    },
    runtime: {
      bridgeVerified: sheetRead.available,
      documentVerified: boundsRead.available,
      drcAvailable: drcRead.available,
      ercAvailable: ercRead.available,
      drc: drcRead.available
        ? normalizeDiagnostics(drcRead.result, 'DRC')
        : [
            {
              message: drcRead.error ?? 'DRC unavailable.',
              classification: 'runtime_limitation',
            },
          ],
      erc: ercRead.available
        ? normalizeDiagnostics(ercRead.result, 'ERC')
        : [
            {
              message: ercRead.error ?? 'ERC unavailable.',
              classification: 'runtime_limitation',
            },
          ],
    },
    visual: {
      captureAvailable,
      deterministicViewport: captureAvailable && sheet.source === 'sheet-info',
      findings: options.visualFindings,
    },
    connectivity: options.connectivity,
    thresholds: options.thresholds,
  });
}

export function registerSchematicLayoutTools(
  registry: { register: (definition: ToolDefinition) => void },
  _config: EnvConfig,
): void {
  registry.register({
    name: 'easyeda_schematic_layout_qa',
    title: 'Run integrated schematic layout QA',
    description:
      'Run a normalized post-write QA pass combining runtime DRC/ERC, expected ' +
      'component/pin topology, rendered primitive bounds, title-block and page constraints, ' +
      'wiring/grouping checks, and connectivity fingerprints, with optional full-page visual ' +
      'evidence. Critical geometry or connectivity findings always block commit.',
    profile: 'pro',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'workflows',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      expectedComponentRefs: z.array(z.string().min(1)).optional(),
      expectedNetNames: z.array(z.string().min(1)).optional(),
      expectedPinMappings: z.array(expectedPinSchema).optional(),
      relationships: z.array(relationshipSchema).optional(),
      connectivity: z
        .object({
          cosmeticOnly: z.boolean(),
          beforeFingerprint: z.string().optional(),
          afterFingerprint: z.string().optional(),
          changedPins: z.array(z.string()).optional(),
          changedWireEndpoints: z.array(z.string()).optional(),
        })
        .optional(),
      thresholds: z
        .object({
          componentClearance: z.number().nonnegative().optional(),
          relatedComponentDistance: z.number().positive().optional(),
          excessiveWireLength: z.number().positive().optional(),
          minimumUtilization: z.number().min(0).max(1).optional(),
          maximumLocalDensity: z.number().min(0).max(1).optional(),
        })
        .optional(),
      visualFindings: z.array(visualFindingSchema).optional(),
      runVisualCapture: z.boolean().default(true),
    }),
    outputSchema: layoutQaOutputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const values = params as {
        projectId: string;
        expectedComponentRefs?: string[];
        expectedNetNames?: string[];
        expectedPinMappings?: ExpectedPinMapping[];
        relationships?: LayoutQaRelationship[];
        connectivity?: LayoutQaInput['connectivity'];
        thresholds?: LayoutQaInput['thresholds'];
        visualFindings?: VisualHeuristicFinding[];
        runVisualCapture?: boolean;
      };
      return collectSchematicLayoutQa(ctx, values.projectId, {
        ...values,
        runVisualCapture: values.runVisualCapture ?? true,
      });
    },
  });

  registry.register({
    name: 'easyeda_schematic_connectivity_fingerprint',
    title: 'Compute schematic connectivity fingerprint',
    description:
      'Compute a deterministic connectivity fingerprint (pin/net membership, wire ' +
      'endpoints, labels/ports, no-connects) from the live schematic. Pass the hash as ' +
      'beforeFingerprint/afterFingerprint to easyeda_schematic_layout_qa to prove a ' +
      'cosmetic move left connectivity unchanged.',
    profile: 'pro',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'workflows',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
    }),
    outputSchema: connectivityFingerprintOutputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      const snapshot = await gatherLiveSchematicSnapshot(ctx, projectId);
      const model = buildSchematicModel(snapshot);
      const fingerprint = createConnectivityFingerprint(model);
      return {
        projectId,
        schemaVersion: fingerprint.schemaVersion,
        hash: fingerprint.hash,
        modelHash: model.modelHash,
        componentCount: model.components.length,
        netCount: model.nets.length,
        normalized: fingerprint.normalized,
        diagnosticCount: model.diagnostics.length,
      };
    },
  });

  registry.register({
    name: 'easyeda_schematic_primitive_bounds',
    title: 'Get schematic primitive bounding boxes',
    description:
      'Read real rendered (sheet-space, rotation-aware) component bounding boxes from the ' +
      'live bridge, batched in one call. Origin is not a collision bound -- use ' +
      'combinedBounds for overlap/page/title-block checks. Reference/value text is not ' +
      'independently addressable here and reports not_available.',
    profile: 'pro',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'workflows',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      primitiveIds: z.array(z.string().min(1)).optional(),
    }),
    outputSchema: primitiveBoundsOutputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, primitiveIds } = params as { projectId: string; primitiveIds?: string[] };
      return gatherLivePrimitiveBounds(ctx, projectId, { primitiveIds });
    },
  });
}
