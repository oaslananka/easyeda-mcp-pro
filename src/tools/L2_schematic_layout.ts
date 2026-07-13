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
import type { PrimitiveBoundsResult } from '../schematic-model/primitive-bounds.js';
import {
  gatherLiveFunctionalLayoutPlan,
  type LiveFunctionalLayoutComponentInput,
} from '../schematic-model/live-functional-layout.js';
import type { FunctionalLayoutConstraints } from '../layout/planner.js';
import type { PlacementConstraintRegion, SafeRegionPreference } from '../layout/placement.js';
import {
  gatherLivePlacementCheck,
  type LivePlacementCandidateInput,
} from '../schematic-model/live-placement-check.js';
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

const functionalRoleSchema = z.enum([
  'main',
  'decoupling-capacitor',
  'bulk-capacitor',
  'feedback-network',
  'pull-up',
  'pull-down',
  'boot-strap',
  'connector-protection',
  'connector-filter',
  'regulator-inductor',
  'regulator-compensation',
  'led-current-limit',
  'transistor-gate-resistor',
  'transistor-base-resistor',
  'test-point',
  'support',
]);

const layoutComponentInputSchema = z.object({
  primitiveId: z.string().min(1),
  blockId: z.string().min(1),
  role: functionalRoleSchema,
  parentId: z.string().optional(),
  preferredRotation: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .optional(),
  allowedRotations: z
    .array(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]))
    .optional(),
  minimumProximity: z.number().nonnegative().optional(),
});

const placementConstraintRegionSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'title-block',
    'page-border',
    'caller-reserved',
    'support-reservation',
    'existing-object',
  ]),
  bounds: boundsSchema,
  primitiveId: z.string().optional(),
  ownerId: z.string().optional(),
});

const placementCandidateSchema = z.object({
  origin: z.object({ x: z.number(), y: z.number() }),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  combinedBounds: boundsSchema,
});

const placementConflictSchema = z.object({
  code: z.enum([
    'PAGE_BORDER_KEEP_OUT',
    'TITLE_BLOCK_KEEP_OUT',
    'CALLER_RESERVED_REGION',
    'SUPPORT_RESERVATION',
    'EXISTING_OBJECT_OCCUPIED',
    'MINIMUM_CLEARANCE',
  ]),
  regionId: z.string(),
  regionKind: z.enum([
    'title-block',
    'page-border',
    'caller-reserved',
    'support-reservation',
    'existing-object',
  ]),
  candidateBounds: boundsSchema,
  conflictingBounds: boundsSchema,
  clearance: z.number(),
  requiredClearance: z.number(),
  message: z.string(),
});

const placementAlternativeSchema = placementCandidateSchema.extend({
  reason: z.string(),
});

const placementCheckResultSchema = z.object({
  accepted: z.boolean(),
  proposed: placementCandidateSchema,
  combinedBounds: boundsSchema,
  clearances: z.array(
    z.object({
      regionId: z.string(),
      regionKind: z.enum([
        'title-block',
        'page-border',
        'caller-reserved',
        'support-reservation',
        'existing-object',
      ]),
      clearance: z.number(),
    }),
  ),
  conflicts: z.array(placementConflictSchema),
  suggestedAlternatives: z.array(placementAlternativeSchema),
  failure: z
    .object({
      code: z.literal('NO_FEASIBLE_POSITION'),
      unsatisfiedConstraints: z.array(z.string()),
      searchedCandidates: z.number().int().nonnegative(),
    })
    .optional(),
});

const placementCheckOutputSchema = z.object({
  mode: z.enum(['check-placement', 'select-safe-region']),
  // check-placement mode
  accepted: z.boolean().optional(),
  proposed: placementCandidateSchema.optional(),
  combinedBounds: boundsSchema.optional(),
  clearances: z
    .array(
      z.object({
        regionId: z.string(),
        regionKind: z.enum([
          'title-block',
          'page-border',
          'caller-reserved',
          'support-reservation',
          'existing-object',
        ]),
        clearance: z.number(),
      }),
    )
    .optional(),
  conflicts: z.array(placementConflictSchema).optional(),
  suggestedAlternatives: z.array(placementAlternativeSchema).optional(),
  failure: z
    .object({
      code: z.literal('NO_FEASIBLE_POSITION'),
      unsatisfiedConstraints: z.array(z.string()),
      searchedCandidates: z.number().int().nonnegative(),
    })
    .optional(),
  // select-safe-region mode
  feasible: z.boolean().optional(),
  preference: z.string().optional(),
  candidate: placementCandidateSchema.optional(),
  check: placementCheckResultSchema.optional(),
  rationale: z.array(z.string()).optional(),
});

const functionalLayoutOutputSchema = z.object({
  feasible: z.boolean(),
  deterministic: z.literal(true),
  layoutHash: z.string(),
  selectedSheet: z.object({
    bounds: boundsSchema,
    drawableBounds: boundsSchema,
    grid: z.number(),
    units: z.string(),
    pageSize: z.enum(['A4', 'A3', 'custom']),
    coordinateOrigin: z.object({
      x: z.number(),
      y: z.number(),
      yAxis: z.enum(['up', 'down']),
      source: z.enum(['runtime', 'live-readback', 'derived']),
    }),
    geometrySource: z.enum(['runtime', 'live-readback', 'derived']),
    titleBlockBounds: boundsSchema.optional(),
  }),
  blockReservations: z.array(
    z.object({
      blockId: z.string(),
      bounds: boundsSchema,
      componentIds: z.array(z.string()),
      supportComponentIds: z.array(z.string()),
    }),
  ),
  supportReservations: z.array(
    z.object({
      id: z.string(),
      blockId: z.string(),
      parentId: z.string().optional(),
      role: functionalRoleSchema,
      componentIds: z.array(z.string()),
      bounds: boundsSchema,
    }),
  ),
  placements: z.array(
    placementCandidateSchema.extend({
      componentId: z.string(),
      blockId: z.string(),
      role: functionalRoleSchema,
      parentId: z.string().optional(),
      placementOrder: z.number().int().nonnegative(),
    }),
  ),
  placementOrder: z.array(z.string()),
  occupancyMap: z.array(placementConstraintRegionSchema),
  conflicts: z.array(
    z.object({
      blockId: z.string().optional(),
      componentId: z.string().optional(),
      code: z.string(),
      message: z.string(),
      constraintIds: z.array(z.string()),
    }),
  ),
  pageSuitability: z.object({
    attempts: z.array(
      z.object({
        pageSize: z.enum(['A4', 'A3', 'custom']),
        feasible: z.boolean(),
        utilization: z.number(),
        unsatisfiedConstraints: z.array(z.string()),
        searchedBlockIds: z.array(z.string()),
      }),
    ),
    selectedPageSize: z.enum(['A4', 'A3', 'custom']).optional(),
    a3FallbackRationale: z.string().optional(),
  }),
  score: z.object({
    overall: z.number(),
    utilization: z.number(),
    proximity: z.number(),
    clearance: z.number(),
    rationale: z.array(z.string()),
  }),
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

/**
 * schematic.primitiveBounds is a pure-geometry endpoint keyed by internal
 * primitiveId -- it has no reference-designator string field at all (the
 * `reference` key it does carry is the bounds of the reference-designator
 * *text label*, not a "U1"-style string). QA's expected-component/pin
 * matching needs real ref strings, so cross-reference against
 * schematic.listComponents separately rather than guessing a ref out of the
 * bounds response (see #288).
 */
async function fetchPrimitiveIdToRef(
  ctx: ToolContext,
  projectId: string,
): Promise<Map<string, string>> {
  const refById = new Map<string, string>();
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    let page: { items?: Array<{ primitiveId?: string; reference?: string }>; total?: number };
    try {
      page = (await ctx.bridge.call('schematic.listComponents', {
        projectId,
        limit: pageSize,
        offset,
      })) as typeof page;
    } catch {
      break;
    }
    const items = page?.items ?? [];
    for (const item of items) {
      if (item.primitiveId && item.reference) refById.set(item.primitiveId, item.reference);
    }
    offset += items.length;
    const total = page?.total ?? items.length;
    if (items.length === 0 || offset >= total) break;
  }
  return refById;
}

async function gatherLivePrimitiveBoundsSafely(
  ctx: ToolContext,
  projectId: string,
): Promise<{ available: boolean; result: PrimitiveBoundsResult[]; error?: string }> {
  try {
    const batch = await gatherLivePrimitiveBounds(ctx, projectId);
    return { available: true, result: batch.items };
  } catch (error) {
    return {
      available: false,
      result: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizePrimitiveBoundsResult(
  item: PrimitiveBoundsResult,
  ref: string | undefined,
): LayoutQaPrimitive | undefined {
  const combined = bounds(item.combinedBounds);
  if (!combined) return undefined;
  return {
    id: item.id,
    primitiveType: normalizePrimitiveType(item.primitiveType),
    ref,
    combinedBounds: combined,
    bodyBounds: bounds(item.body?.bounds),
    referenceBounds: bounds(item.reference?.bounds),
    valueBounds: bounds(item.value?.bounds),
    pinTextBounds: boundsArray(item.pinTexts?.map((segment) => segment.bounds)),
    labelBounds: boundsArray(item.labels?.map((segment) => segment.bounds)),
    annotationBounds: boundsArray(item.annotations?.map((segment) => segment.bounds)),
    rotation: item.rotation,
    geometrySource: normalizeGeometrySource(item.geometrySource),
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

  const [boundsRead, refByPrimitiveId, netsRead, wiresRead, drcRead, ercRead] = await Promise.all([
    gatherLivePrimitiveBoundsSafely(ctx, projectId),
    fetchPrimitiveIdToRef(ctx, projectId),
    optionalBridgeCall(ctx, 'schematic.listNets', { projectId }),
    optionalBridgeCall(ctx, 'system.inspectWires', { projectId, limit: 10_000, offset: 0 }),
    optionalBridgeCall(ctx, 'design.drc', { projectId }),
    optionalBridgeCall(ctx, 'design.erc', { projectId }),
  ]);

  const pinsByRef = netPinMap(netsRead.result);
  const primitives = boundsRead.result
    .map((item) => normalizePrimitiveBoundsResult(item, refByPrimitiveId.get(item.id)))
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

  registry.register({
    name: 'easyeda_schematic_plan_layout',
    title: 'Plan deterministic functional-block layout',
    description:
      'Deterministically plan functional-block placement (reserved rectangles, support space, ' +
      'grid-aligned coordinates, occupancy map, A3 fallback, score) from real sheet/primitive ' +
      'geometry -- no writes. Caller supplies roles/blockId/parentId; other primitives read as ' +
      'occupied regions, never overwritten.',
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
      components: z.array(layoutComponentInputSchema).min(1),
      allowA3Fallback: z.boolean().default(false),
      hardKeepouts: z.array(placementConstraintRegionSchema).optional(),
      constraints: z
        .object({
          minimumClearance: z.number().nonnegative().optional(),
          blockPadding: z.number().nonnegative().optional(),
          componentSpacing: z.number().nonnegative().optional(),
          preferredFlow: z.enum(['left-to-right', 'top-to-bottom']).optional(),
          maximumSupportDistance: z.number().positive().optional(),
          minimumReadableUtilization: z.number().min(0).max(1).optional(),
          maximumReadableUtilization: z.number().min(0).max(1).optional(),
        })
        .optional(),
    }),
    outputSchema: functionalLayoutOutputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const values = params as {
        projectId: string;
        components: LiveFunctionalLayoutComponentInput[];
        allowA3Fallback: boolean;
        hardKeepouts?: PlacementConstraintRegion[];
        constraints?: Partial<FunctionalLayoutConstraints>;
      };
      return gatherLiveFunctionalLayoutPlan(ctx, values.projectId, values.components, {
        a3FallbackAllowed: values.allowA3Fallback,
        hardKeepouts: values.hardKeepouts,
        constraints: values.constraints,
      });
    },
  });

  registry.register({
    name: 'easyeda_schematic_check_placement',
    title: 'Check or find a safe schematic placement',
    description:
      'Validate a candidate placement (rendered bounds, clearances, conflicts, deterministic ' +
      'alternatives) or -- when x/y are omitted -- search for a safe region of the given size, ' +
      'against real title-block/page-border/existing-primitive constraints. Read-only, no writes.',
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
      candidate: z.object({
        width: z.number().positive(),
        height: z.number().positive(),
        x: z.number().optional(),
        y: z.number().optional(),
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
        preference: z
          .enum([
            'upper-left',
            'upper-center',
            'upper-right',
            'center-left',
            'center',
            'center-right',
            'lower-left',
            'lower-center',
            'lower-right',
          ])
          .optional(),
      }),
      reservedRegions: z.array(placementConstraintRegionSchema).optional(),
      minimumClearance: z.number().nonnegative().optional(),
      excludePrimitiveIds: z.array(z.string().min(1)).optional(),
    }),
    outputSchema: placementCheckOutputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const values = params as {
        projectId: string;
        candidate: LivePlacementCandidateInput & { preference?: SafeRegionPreference };
        reservedRegions?: PlacementConstraintRegion[];
        minimumClearance?: number;
        excludePrimitiveIds?: string[];
      };
      return gatherLivePlacementCheck(ctx, values.projectId, values.candidate, {
        reservedRegions: values.reservedRegions,
        minimumClearance: values.minimumClearance,
        excludePrimitiveIds: values.excludePrimitiveIds,
      });
    },
  });
}
