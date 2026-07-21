import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { readStable } from '../live/readback.js';
import { fetchComponentPins } from './schematic-helpers.js';
import {
  collisionScanErrorMessage,
  scanSheetForPinCollisionsDetailed,
} from '../workflows/collision.js';
import { planSafeSchematicRegion } from '../workflows/schematic-safe-region.js';
import {
  auditImportedDesign,
  buildCanonicalSchematicModel,
  ImportedNormalizationPlanSchema,
  NormalizationComponentOverrideSchema,
  normalizeNetName,
  normalizeSchematicComponent,
  previewImportedNormalization,
} from '../schematic-model/index.js';

const schematicRegionPreferenceSchema = z.enum([
  'upper-left',
  'upper-center',
  'upper-right',
  'center-left',
  'center',
  'center-right',
  'lower-left',
  'lower-center',
  'lower-right',
]);

const importedNormalizationPreviewInputSchema = z
  .object({
    projectId: z.string().describe('The project/schematic ID to preview'),
    componentLimit: z.coerce.number().int().min(1).max(500).default(500),
    normalizeNetNames: z.boolean().default(true),
    annotateReferences: z.boolean().default(true),
    resolveMetadataExpressions: z.boolean().default(true),
    componentOverrides: z.array(NormalizationComponentOverrideSchema).max(500).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.componentOverrides.forEach((override, index) => {
      if (seen.has(override.componentId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate component override for ${override.componentId}`,
          path: ['componentOverrides', index, 'componentId'],
        });
      }
      seen.add(override.componentId);
    });
  });

const searchDeviceInputSchema = z.object({
  key: z
    .string()
    .describe('Search keyword(s), matched against device name/description in the library'),
  libraryUuid: z.string().optional(),
  classification: z.union([z.string(), z.array(z.string())]).optional(),
  symbolType: z.string().optional(),
  itemsOfPage: z.number().int().default(20),
  page: z.number().int().default(1),
  minimal: z
    .boolean()
    .optional()
    .describe(
      'When true, return only uuid/libraryUuid/name/pin_count/symbol_type per device instead of ' +
        'the full library metadata object — use this when the goal is just picking a deviceItem ' +
        'for place_component, to avoid paying for fields you will not read.',
    ),
});

const readConsistencySchema = z.object({
  stable: z.boolean(),
  attempts: z.number().int().positive(),
});

const stableReadOptions = { attempts: 4, delayMs: 80 } as const;

const _deviceItemSchema = z
  .object({
    libraryUuid: z.string(),
    uuid: z.string(),
  })
  .passthrough();

type SearchDeviceItem = Record<string, unknown>;

const searchDevicePinCountKeys = [
  'pin_count',
  'pinCount',
  'pinsCount',
  'pinNumber',
  'pin_num',
  'pinNum',
  'PinCount',
] as const;

const searchDevicePinArrayKeys = ['pins', 'pinList', 'pin_list', 'symbolPins'] as const;

const searchDeviceSymbolTypeKeys = [
  'symbol_type',
  'symbolType',
  'type',
  'deviceType',
  'symbol_type_name',
  'SymbolType',
] as const;

function searchDeviceStringMetadata(
  item: SearchDeviceItem,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function searchDeviceNumberMetadata(
  item: SearchDeviceItem,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

function searchDeviceArrayLengthMetadata(
  item: SearchDeviceItem,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

const searchDeviceNameKeys = ['name', 'title', 'deviceName', 'symbolName', 'className'] as const;

function normalizeSearchDeviceItem(item: unknown): SearchDeviceItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { raw: item };

  const normalized: SearchDeviceItem = { ...(item as SearchDeviceItem) };
  const pinCount =
    searchDeviceNumberMetadata(normalized, searchDevicePinCountKeys) ??
    searchDeviceArrayLengthMetadata(normalized, searchDevicePinArrayKeys);
  if (pinCount !== undefined) normalized.pin_count = pinCount;

  const symbolType = searchDeviceStringMetadata(normalized, searchDeviceSymbolTypeKeys);
  if (symbolType) normalized.symbol_type = symbolType;

  return normalized;
}

/** Projects a normalized device item down to just enough to pick a deviceItem for
 *  place_component — see the `minimal` input flag. */
function minimalSearchDeviceItem(item: SearchDeviceItem): SearchDeviceItem {
  const minimal: SearchDeviceItem = {};
  if (typeof item.uuid === 'string') minimal.uuid = item.uuid;
  if (typeof item.libraryUuid === 'string') minimal.libraryUuid = item.libraryUuid;
  const name = searchDeviceStringMetadata(item, searchDeviceNameKeys);
  if (name) minimal.name = name;
  if (item.pin_count !== undefined) minimal.pin_count = item.pin_count;
  if (item.symbol_type !== undefined) minimal.symbol_type = item.symbol_type;
  return minimal;
}

function registerSchematicReadTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_schematic_nets',
    title: 'List schematic nets',
    description: 'List all nets in the schematic with their node connections.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      nets: z.array(
        z.object({
          net_name: z.string(),
          raw_net_name: z.string(),
          canonical_net_name: z.string(),
          net_kind: z.enum(['signal', 'power', 'ground', 'power-flag', 'unnamed']),
          normalization_rules: z.array(z.string()),
          imported_alias: z.boolean(),
          node_count: z.number().int().nonnegative(),
          nodes: z.array(
            z.object({
              component_ref: z.string(),
              pin: z.string(),
            }),
          ),
        }),
      ),
      total: z.number().int().nonnegative(),
      read_consistency: readConsistencySchema.optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const observation = await readStable(
          () => ctx.bridge.call('schematic.listNets', { projectId }),
          stableReadOptions,
        );
        const result = observation.value;
        const nets = result as Array<{
          netName?: string;
          nodes?: Array<{ component?: string; pin?: string }>;
        }>;
        return {
          project_id: projectId,
          nets: (nets ?? []).map((n) => {
            const normalized = normalizeNetName(n.netName ?? '');
            return {
              net_name: n.netName ?? '',
              raw_net_name: normalized.rawNetName,
              canonical_net_name: normalized.canonicalNetName,
              net_kind: normalized.kind,
              normalization_rules: normalized.rules,
              imported_alias: normalized.imported,
              node_count: n.nodes?.length ?? 0,
              nodes: (n.nodes ?? []).map((nd) => ({
                component_ref: nd.component ?? '',
                pin: nd.pin ?? '',
              })),
            };
          }),
          total: nets?.length ?? 0,
          read_consistency: {
            stable: observation.stable,
            attempts: observation.attempts,
          },
        };
      } catch (err) {
        return {
          project_id: projectId,
          nets: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_components',
    title: 'List schematic components',
    description:
      'List schematic components: primitiveId, reference, value, footprint, x/y/rotation, and ' +
      'device identity for cloning — deviceUuid+deviceLibraryUuid (a place_component deviceItem ' +
      'in this project), deviceName, symbolName, lcsc, manufacturerId.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      components: z.array(
        z.object({
          primitiveId: z.string().optional(),
          reference: z.string(),
          value: z.string(),
          footprint: z.string(),
          lcsc: z.string().optional(),
          manufacturer: z.string().optional(),
          manufacturerId: z.string().optional(),
          datasheet: z.string().optional(),
          deviceUuid: z.string().optional(),
          deviceLibraryUuid: z.string().optional(),
          deviceName: z.string().optional(),
          symbolName: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          rotation: z.number().optional(),
          component_kind: z.enum([
            'part',
            'power-symbol',
            'power-flag',
            'net-label',
            'net-port',
            'sheet-frame',
            'annotation',
            'helper',
            'unknown',
          ]),
          bom_eligible: z.boolean(),
          electrical_eligible: z.boolean(),
          annotated: z.boolean(),
          symbol_source: z.enum(['native', 'imported', 'unknown']),
          raw_value: z.string(),
          raw_footprint: z.string(),
        }),
      ),
      total: z.number().int().nonnegative(),
      read_consistency: readConsistencySchema.optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, limit, offset } = params as {
        projectId: string;
        limit: number;
        offset: number;
      };
      try {
        const observation = await readStable(
          () =>
            ctx.bridge.call('schematic.listComponents', {
              projectId,
              limit,
              offset,
            }),
          stableReadOptions,
        );
        const result = observation.value;
        const { total: bridgeTotal, items } = result as {
          total?: number;
          items?: Array<{
            primitiveId?: string;
            reference?: string;
            value?: string;
            footprint?: string;
            lcsc?: string;
            manufacturer?: string;
            manufacturerId?: string;
            datasheet?: string;
            deviceUuid?: string;
            deviceLibraryUuid?: string;
            deviceName?: string;
            symbolName?: string;
            x?: number;
            y?: number;
            rotation?: number;
          }>;
        };
        const comps = items ?? [];
        return {
          project_id: projectId,
          components: comps.map((c, index) => {
            const normalized = normalizeSchematicComponent(c, index);
            return {
              primitiveId: c.primitiveId,
              reference: normalized.reference,
              value: normalized.value,
              footprint: normalized.footprint,
              lcsc: normalized.lcsc,
              manufacturer: normalized.manufacturer,
              manufacturerId: normalized.manufacturerPart,
              datasheet: normalized.datasheet,
              deviceUuid: c.deviceUuid,
              deviceLibraryUuid: c.deviceLibraryUuid,
              deviceName: normalized.deviceName,
              symbolName: normalized.symbolName,
              x: normalized.x,
              y: normalized.y,
              rotation: normalized.rotation,
              component_kind: normalized.componentKind,
              bom_eligible: normalized.bomEligible,
              electrical_eligible: normalized.electricalEligible,
              annotated: normalized.annotated,
              symbol_source: normalized.symbolSource,
              raw_value: normalized.rawValue,
              raw_footprint: normalized.rawFootprint,
            };
          }),
          total: bridgeTotal ?? comps.length,
          read_consistency: {
            stable: observation.stable,
            attempts: observation.attempts,
          },
        };
      } catch (err) {
        return {
          project_id: projectId,
          components: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_wires',
    title: 'List schematic wires',
    description:
      'List wire segments: primitiveId, line coordinates, net name, color, style. Page with ' +
      'offset (check total) past the 50-wire-per-call cap. primitiveId is required by ' +
      'delete_primitive/modify_primitive — schematic_nets alone cannot resolve a wire ID.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      limit: z.coerce.number().int().min(1).max(50).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      wires: z.array(
        z.object({
          primitiveId: z.string().optional(),
          line: z.unknown().optional(),
          net: z.string().optional(),
          color: z.string().nullable().optional(),
          lineWidth: z.number().nullable().optional(),
          lineType: z.unknown().optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      read_consistency: readConsistencySchema.optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, limit, offset } = params as {
        projectId: string;
        limit: number;
        offset: number;
      };
      try {
        const observation = await readStable(
          () => ctx.bridge.call('system.inspectWires', { limit, offset }),
          stableReadOptions,
        );
        const result = observation.value;
        const data = result as {
          total?: number;
          samples?: Array<{
            primitiveId?: string;
            line?: unknown;
            net?: string;
            color?: string | null;
            lineWidth?: number | null;
            lineType?: unknown;
          }>;
        };
        return {
          project_id: projectId,
          wires: (data.samples ?? []).map((w) => ({
            primitiveId: w.primitiveId,
            line: w.line,
            net: w.net,
            color: w.color,
            lineWidth: w.lineWidth,
            lineType: w.lineType,
          })),
          total: data.total ?? data.samples?.length ?? 0,
          read_consistency: {
            stable: observation.stable,
            attempts: observation.attempts,
          },
        };
      } catch (err) {
        return {
          project_id: projectId,
          wires: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_net_detail',
    title: 'Get schematic net detail',
    description:
      'Get full details for a specific net in the schematic including all connected pins and components.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.2.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      net_name: z.string(),
      node_count: z.number().int().nonnegative(),
      nodes: z.array(
        z.object({
          component_ref: z.string(),
          pin: z.string(),
        }),
      ),
      not_available: z.boolean().optional(),
      timed_out: z.boolean().optional(),
      error_code: z.string().optional(),
      timeout_stage: z.string().optional(),
      timeout_component: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, netName } = params as { projectId: string; netName: string };
      try {
        const result = await ctx.bridge.call(
          'schematic.getNetDetail',
          { projectId, netName, operationTimeoutMs: 15_000 },
          { timeoutMs: 20_000 },
        );
        const net = result as {
          netName?: string;
          nodes?: Array<{ component?: string; pin?: string }>;
        };
        if (!net) {
          return {
            project_id: projectId,
            net_name: netName,
            node_count: 0,
            nodes: [],
            not_available: true,
          };
        }
        return {
          project_id: projectId,
          net_name: net.netName ?? netName,
          node_count: net.nodes?.length ?? 0,
          nodes: (net.nodes ?? []).map((nd) => ({
            component_ref: nd.component ?? '',
            pin: nd.pin ?? '',
          })),
        };
      } catch (err) {
        const record =
          err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
        const errorCode = typeof record?.code === 'string' ? record.code : undefined;
        const data =
          record?.data && typeof record.data === 'object'
            ? (record.data as Record<string, unknown>)
            : undefined;
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = errorCode === 'NET_DETAIL_TIMEOUT' || /timed out/i.test(message);
        return {
          project_id: projectId,
          net_name: netName,
          node_count: 0,
          nodes: [],
          not_available: true,
          timed_out: timedOut || undefined,
          error_code: errorCode,
          timeout_stage: typeof data?.stage === 'string' ? data.stage : undefined,
          timeout_component: typeof data?.component === 'string' ? data.component : undefined,
          error: message,
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_search_device',
    title: 'Search library device',
    description:
      'Search for schematic symbols/devices in the EasyEDA library by keywords. Full results ' +
      "carry the library's complete metadata object per device; pass minimal:true to get back " +
      'only uuid/libraryUuid/name/pin_count/symbol_type when that is all you need.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: searchDeviceInputSchema,
    outputSchema: z.object({
      devices: z.array(
        z
          .object({
            pin_count: z.number().int().nonnegative().optional(),
            symbol_type: z.string().optional(),
          })
          .passthrough(),
      ),
      total: z.number().int().nonnegative(),
      /** Where the result came from. Always 'local_library' — this tool queries the
       *  active EasyEDA Pro session's device library, not vendor/supplier catalogs. */
      provider_tier: z.literal('local_library').optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { key, libraryUuid, classification, symbolType, itemsOfPage, page, minimal } =
        searchDeviceInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.searchDevice', {
          key,
          libraryUuid,
          classification,
          symbolType,
          itemsOfPage,
          page,
        });
        const normalized = Array.isArray(result) ? result.map(normalizeSearchDeviceItem) : [];
        const devices = minimal ? normalized.map(minimalSearchDeviceItem) : normalized;
        return {
          devices,
          total: devices.length,
          provider_tier: 'local_library' as const,
        };
      } catch (err) {
        return {
          devices: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_sheet_info',
    title: 'Get schematic sheet info',
    description:
      'Return read-only active schematic sheet metadata including page size, frame, origin, and grid hints for safer component placement.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.1.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string().optional(),
      sheet: z.unknown().optional(),
      page_size: z
        .object({
          width: z.number().optional(),
          height: z.number().optional(),
          unit: z.string().optional(),
        })
        .optional(),
      frame: z.unknown().optional(),
      origin: z.unknown().optional(),
      grid: z.unknown().optional(),
      raw: z.unknown().optional(),
      metadata_source: z.string().optional(),
      focused_document: z.unknown().optional(),
      diagnostics: z.unknown().optional(),
      geometry_available: z.boolean(),
      warning: z.string().optional(),
      not_available: z.boolean().optional(),
      error_code: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = z.object({ projectId: z.string().optional() }).parse(params ?? {});
      try {
        const result = await ctx.bridge.call('schematic.getSheetInfo', { projectId });
        const root =
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : {};
        const isNonEmptyRecord = (value: unknown): value is Record<string, unknown> =>
          Boolean(
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value as Record<string, unknown>).length > 0,
          );
        const wrappedCurrent = isNonEmptyRecord(root.currentPage) ? root.currentPage : undefined;
        const hasLegacyDirectSheetData = [
          'uuid',
          'name',
          'width',
          'height',
          'pageWidth',
          'pageHeight',
          'paperWidth',
          'paperHeight',
          'frame',
          'titleBlock',
          'origin',
          'canvasOrigin',
          'grid',
          'gridSize',
        ].some((key) => root[key] !== undefined && root[key] !== null);
        const current = wrappedCurrent ?? (hasLegacyDirectSheetData ? root : undefined);
        if (!current) {
          return {
            project_id: projectId,
            geometry_available: false,
            not_available: true,
            diagnostics: root.diagnostics,
            error: 'EasyEDA did not expose metadata for the focused schematic page.',
          };
        }
        const readNumber = (keys: string[]): number | undefined => {
          for (const key of keys) {
            const value = current[key] ?? root[key];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string') {
              const parsed = Number(value.trim());
              if (Number.isFinite(parsed)) return parsed;
            }
          }
          return undefined;
        };
        const readString = (keys: string[]): string | undefined => {
          for (const key of keys) {
            const value = current[key] ?? root[key];
            if (typeof value === 'string' && value.trim()) return value;
          }
          return undefined;
        };
        const width = readNumber(['width', 'pageWidth', 'paperWidth', 'w']);
        const height = readNumber(['height', 'pageHeight', 'paperHeight', 'h']);
        const unit = readString(['unit', 'units', 'pageUnit']);
        const frame = current.frame ?? current.titleBlock ?? root.frame;
        const origin = current.origin ?? current.canvasOrigin ?? root.origin;
        const grid = current.grid ?? current.gridSize ?? root.grid;
        const geometryAvailable =
          width !== undefined ||
          height !== undefined ||
          unit !== undefined ||
          frame !== undefined ||
          origin !== undefined ||
          grid !== undefined;
        const pageSize =
          width !== undefined || height !== undefined || unit !== undefined
            ? { width, height, unit }
            : undefined;
        return {
          project_id: projectId,
          sheet: current,
          ...(pageSize ? { page_size: pageSize } : {}),
          ...(frame !== undefined ? { frame } : {}),
          ...(origin !== undefined ? { origin } : {}),
          ...(grid !== undefined ? { grid } : {}),
          raw: result,
          ...(typeof root.source === 'string' ? { metadata_source: root.source } : {}),
          ...(root.focusedDocument !== undefined ? { focused_document: root.focusedDocument } : {}),
          ...(root.diagnostics !== undefined ? { diagnostics: root.diagnostics } : {}),
          geometry_available: geometryAvailable,
          ...(geometryAvailable
            ? {}
            : {
                warning:
                  'Focused schematic page identity is available, but this EasyEDA runtime did not expose page geometry.',
              }),
        };
      } catch (err) {
        const record =
          err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
        return {
          project_id: projectId,
          geometry_available: false,
          not_available: true,
          error_code: typeof record?.code === 'string' ? record.code : undefined,
          diagnostics: record?.data,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_plan_safe_region',
    title: 'Plan safe schematic drawing region',
    description:
      'Compute a safe schematic drawing region before placing components. Uses live sheet info when available, assumes EasyEDA bottom-left coordinates, reserves the default lower-right title-block keep-out, and returns an anchor/bounds plan that avoids title-block overlap.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      contentWidth: z
        .number()
        .positive()
        .describe('Estimated width of the planned circuit block in EasyEDA coordinates'),
      contentHeight: z
        .number()
        .positive()
        .describe('Estimated height of the planned circuit block in EasyEDA coordinates'),
      preferredRegion: schematicRegionPreferenceSchema.default('upper-left'),
      margin: z.number().positive().optional(),
      titleBlockKeepout: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .optional()
        .describe(
          'Optional explicit title-block keep-out rectangle when the sheet template is known',
        ),
    }),
    outputSchema: z.object({
      project_id: z.string().optional(),
      blocked: z.boolean(),
      preferred_region: z.string(),
      sheet: z.object({
        width: z.number(),
        height: z.number(),
        unit: z.string(),
        origin: z.string(),
        source: z.string(),
      }),
      usable_bounds: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      requested_bounds: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      anchor: z.object({ x: z.number(), y: z.number() }),
      keepouts: z.array(
        z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          kind: z.string(),
        }),
      ),
      warnings: z.array(z.string()),
      issues: z.array(z.object({ code: z.string(), message: z.string() })),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = z
        .object({
          projectId: z.string().optional(),
          contentWidth: z.number().positive(),
          contentHeight: z.number().positive(),
          preferredRegion: schematicRegionPreferenceSchema.default('upper-left'),
          margin: z.number().positive().optional(),
          titleBlockKeepout: z
            .object({
              x: z.number(),
              y: z.number(),
              width: z.number().positive(),
              height: z.number().positive(),
            })
            .optional(),
        })
        .parse(params ?? {});
      let sheetInfo: unknown;
      try {
        sheetInfo = await ctx.bridge.call('schematic.getSheetInfo', { projectId: p.projectId });
      } catch {
        // Degrade to the conservative A4 default rather than blocking preview
        // planning, because this tool is often used before a live sheet is fully ready.
        sheetInfo = undefined;
      }
      const plan = planSafeSchematicRegion({
        sheetInfo,
        contentWidth: p.contentWidth,
        contentHeight: p.contentHeight,
        preferredRegion: p.preferredRegion,
        margin: p.margin,
        titleBlockKeepout: p.titleBlockKeepout,
      });
      return {
        project_id: p.projectId,
        blocked: plan.blocked,
        preferred_region: plan.preferredRegion,
        sheet: plan.sheet,
        usable_bounds: plan.usableBounds,
        requested_bounds: plan.requestedBounds,
        bounds: plan.bounds,
        anchor: plan.anchor,
        keepouts: plan.keepouts,
        warnings: plan.warnings,
        issues: plan.issues,
      };
    },
  });

  registry.register({
    name: 'easyeda_schematic_verify_write',
    title: 'Verify schematic write result',
    description:
      'Read back schematic state after an agent-authored write. Returns component-count delta evidence and optional netlist validation so agents can confirm a placement or connection before continuing.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      netName: z.string().optional(),
      beforeComponentCount: z.number().int().nonnegative().optional(),
      expectedComponentCountDelta: z.number().int().optional(),
      includeWireCheck: z.boolean().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string().optional(),
      net_name: z.string().optional(),
      components_available: z.boolean(),
      component_count: z.number().int().nonnegative().optional(),
      component_count_delta: z.number().int().optional(),
      component_delta_matches: z.boolean().optional(),
      netlist_available: z.boolean(),
      netlist_validation: z.unknown().optional(),
      warnings: z.array(z.string()),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = z
        .object({
          projectId: z.string().optional(),
          netName: z.string().optional(),
          beforeComponentCount: z.number().int().nonnegative().optional(),
          expectedComponentCountDelta: z.number().int().optional(),
          includeWireCheck: z.boolean().optional(),
        })
        .parse(params ?? {});
      const warnings: string[] = [];
      let componentCount: number | undefined;
      let componentCountDelta: number | undefined;
      let componentDeltaMatches: boolean | undefined;
      let componentsAvailable = false;
      let netlistAvailable = false;
      let netlistValidation: unknown;

      try {
        const components = await ctx.bridge.call('schematic.listComponents', {
          projectId: p.projectId,
          limit: 500,
          offset: 0,
        });
        if (Array.isArray(components)) {
          componentsAvailable = true;
          componentCount = components.length;
          if (p.beforeComponentCount !== undefined) {
            componentCountDelta = componentCount - p.beforeComponentCount;
            if (p.expectedComponentCountDelta !== undefined) {
              componentDeltaMatches = componentCountDelta === p.expectedComponentCountDelta;
              if (!componentDeltaMatches) {
                warnings.push(
                  `Expected component-count delta ${p.expectedComponentCountDelta}, got ${componentCountDelta}.`,
                );
              }
            }
          }
        } else {
          warnings.push('Component read-back returned a non-array response.');
        }
      } catch (err) {
        warnings.push(
          `Component read-back unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        netlistValidation = await ctx.bridge.call('schematic.validateNetlist', {
          projectId: p.projectId,
          netName: p.netName,
          includeWireCheck: p.includeWireCheck ?? false,
        });
        netlistAvailable = true;
      } catch (err) {
        warnings.push(
          `Netlist validation unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {
        project_id: p.projectId,
        net_name: p.netName,
        components_available: componentsAvailable,
        component_count: componentCount,
        component_count_delta: componentCountDelta,
        component_delta_matches: componentDeltaMatches,
        netlist_available: netlistAvailable,
        netlist_validation: netlistValidation,
        warnings,
      };
    },
  });
  registry.register({
    name: 'easyeda_schematic_component_pins',
    title: 'Get component pins',
    description:
      'Get exact pin primitive IDs, numbers, names, coordinates, native no-connect state, and pinType for a schematic component ' +
      "by its primitive ID. pinType is EasyEDA's own symbol-library field and is unreliably " +
      'authored (often "Undefined" even on real ICs) — treat it as a weak hint, not ground truth.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.1.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      primitiveId: z.string(),
    }),
    outputSchema: z.object({
      primitiveId: z.string(),
      pins: z.array(
        z.object({
          primitiveId: z.string().optional(),
          noConnected: z.boolean().optional(),
          pinNumber: z.string(),
          pinName: z.string(),
          x: z.number(),
          y: z.number(),
          rotation: z.number(),
          pinLength: z.number(),
          pinType: z.string().optional(),
        }),
      ),
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { primitiveId } = params as { primitiveId: string };
      try {
        const pins = await fetchComponentPins(ctx, primitiveId);
        return { primitiveId, pins, success: true };
      } catch (err) {
        return {
          primitiveId,
          pins: [],
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_check_collisions',
    title: 'Check for pin-coordinate collisions across the sheet',
    description:
      "Scan every component's real pin coordinates and report any (x,y) shared by two or more " +
      'components — a silent-short risk the native NET_COLLISION guard misses for never-wired ' +
      'pins. Run after manual placement outside easyeda_workflow_* tools (which reconcile this ' +
      'automatically).',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.1.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      collisions: z.array(
        z.object({
          x: z.number(),
          y: z.number(),
          pins: z.array(
            z.object({
              primitiveId: z.string(),
              pinNumber: z.string(),
              pinName: z.string(),
            }),
          ),
        }),
      ),
      collision_count: z.number().int().nonnegative(),
      scan_complete: z.boolean(),
      scan_diagnostics: z
        .object({
          stage: z.enum(['complete', 'component_enumeration', 'pin_lookup']),
          component_count: z.number().int().nonnegative(),
          components_scanned: z.number().int().nonnegative(),
          failed_component_count: z.number().int().nonnegative(),
          failed_components: z.array(
            z.object({
              primitive_id: z.string(),
              error: z.string(),
            }),
          ),
          duration_ms: z.number().int().nonnegative(),
          component_enumeration_ms: z.number().int().nonnegative(),
          pin_lookup_ms: z.number().int().nonnegative(),
          concurrency: z.number().int().positive(),
          per_call_timeout_ms: z.number().int().positive(),
          overall_timeout_ms: z.number().int().positive(),
          stage_error: z.string().optional(),
        })
        .optional(),
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const scan = await scanSheetForPinCollisionsDetailed(ctx, projectId);
        const diagnostics = scan.diagnostics;
        const scanDiagnostics = {
          stage: diagnostics.stage,
          component_count: diagnostics.componentCount,
          components_scanned: diagnostics.componentsScanned,
          failed_component_count: diagnostics.failedComponents.length,
          failed_components: diagnostics.failedComponents.map((failure) => ({
            primitive_id: failure.primitiveId,
            error: failure.error,
          })),
          duration_ms: diagnostics.durationMs,
          component_enumeration_ms: diagnostics.componentEnumerationMs,
          pin_lookup_ms: diagnostics.pinLookupMs,
          concurrency: diagnostics.concurrency,
          per_call_timeout_ms: diagnostics.perCallTimeoutMs,
          overall_timeout_ms: diagnostics.overallTimeoutMs,
          stage_error: diagnostics.stageError,
        };
        const complete = diagnostics.stage === 'complete';
        return {
          project_id: projectId,
          collisions: scan.collisions,
          collision_count: scan.collisions.length,
          scan_complete: complete,
          scan_diagnostics: scanDiagnostics,
          success: complete,
          error: complete
            ? undefined
            : diagnostics.stage === 'component_enumeration' && diagnostics.stageError
              ? diagnostics.stageError
              : collisionScanErrorMessage(diagnostics),
        };
      } catch (err) {
        return {
          project_id: projectId,
          collisions: [],
          collision_count: 0,
          scan_complete: false,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_validate_netlist',
    title: 'Validate netlist',
    description:
      'Validate the schematic netlist: inferred nets, connected refs/pins, floating pins, plus a ' +
      'cross-check with native ERC (native_erc). `valid` needs BOTH the inference clean AND ' +
      'native ERC 0 errors — inference alone false-positives when pins overlap without a wire.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      includeWireCheck: z
        .boolean()
        .default(false)
        .describe('When true, also check for graphical wires without netlist connectivity'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      netlist: z.array(
        z.object({
          net_name: z.string(),
          connected_refs: z.array(z.string()),
          connected_pins: z.array(z.string()),
          has_net_flag: z.boolean(),
        }),
      ),
      total_nets: z.number().int().nonnegative(),
      floating_pins: z.array(
        z.object({
          primitiveId: z.string(),
          designator: z.string().optional(),
          pinNumber: z.string(),
        }),
      ),
      wires_without_netlist: z
        .array(
          z.object({
            wireId: z.string(),
            netName: z.string().optional(),
          }),
        )
        .optional(),
      native_erc: z
        .object({
          error_count: z.number().int().nonnegative(),
          warning_count: z.number().int().nonnegative(),
          passed: z.boolean(),
        })
        .optional(),
      valid: z.boolean(),
      warnings: z.array(z.string()),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, includeWireCheck } = params as {
        projectId: string;
        includeWireCheck: boolean;
      };
      try {
        const result = await ctx.bridge.call('schematic.validateNetlist', {
          projectId,
          includeWireCheck,
        });
        const data = result as {
          nets?: Array<{
            netName?: string;
            refs?: string[];
            pins?: string[];
            hasNetFlag?: boolean;
          }>;
          floatingPins?: Array<{ primitiveId?: string; designator?: string; pinNumber?: string }>;
          wiresWithoutNetlist?: Array<{ wireId?: string; netName?: string }>;
          nativeErc?: { errorCount?: number; warningCount?: number; passed?: boolean };
          warnings?: string[];
        };
        const nativeErcPassed = data.nativeErc?.passed ?? true;
        return {
          project_id: projectId,
          netlist: (data.nets ?? []).map((n) => ({
            net_name: n.netName ?? '',
            connected_refs: n.refs ?? [],
            connected_pins: n.pins ?? [],
            has_net_flag: n.hasNetFlag ?? false,
          })),
          total_nets: data.nets?.length ?? 0,
          floating_pins: (data.floatingPins ?? []).map((fp) => ({
            primitiveId: fp.primitiveId ?? '',
            designator: fp.designator,
            pinNumber: fp.pinNumber ?? '',
          })),
          wires_without_netlist: data.wiresWithoutNetlist
            ? data.wiresWithoutNetlist.map((w) => ({
                wireId: w.wireId ?? '',
                netName: w.netName,
              }))
            : undefined,
          native_erc: data.nativeErc
            ? {
                error_count: data.nativeErc.errorCount ?? 0,
                warning_count: data.nativeErc.warningCount ?? 0,
                passed: data.nativeErc.passed ?? false,
              }
            : undefined,
          // Authoritative: only valid when the inference is clean AND EasyEDA's
          // native ERC reports zero errors (overlapping-but-unwired pins pass
          // the inference but fail native ERC).
          valid: data.warnings?.length === 0 && nativeErcPassed,
          warnings: data.warnings ?? [],
        };
      } catch (err) {
        return {
          project_id: projectId,
          netlist: [],
          total_nets: 0,
          floating_pins: [],
          valid: false,
          warnings: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_audit_imported_design',
    title: 'Audit imported schematic design',
    description:
      'Read the live schematic without modifying it, build a canonical model, and report imported ' +
      'net aliases, duplicate or missing references, unresolved metadata expressions, missing ' +
      'values/footprints, and ambiguous BOM classification. Includes a preview only; it never ' +
      'renames nets or changes components.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID to audit'),
      includeInfo: z
        .boolean()
        .default(true)
        .describe('Include informational imported-alias and power-flag findings'),
      componentLimit: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(500)
        .describe('Maximum number of component records to read from the live bridge'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      audit_schema_version: z.literal('imported-design-audit/v1'),
      status: z.enum(['clean', 'review', 'blocked']),
      read_only: z.literal(true),
      safe_to_normalize: z.boolean(),
      source: z.object({
        component_total: z.number().int().nonnegative(),
        component_items_read: z.number().int().nonnegative(),
        net_items_read: z.number().int().nonnegative(),
        source_truncated: z.boolean(),
      }),
      model_summary: z.object({
        component_count: z.number().int().nonnegative(),
        bom_component_count: z.number().int().nonnegative(),
        electrical_component_count: z.number().int().nonnegative(),
        net_count: z.number().int().nonnegative(),
        imported_component_count: z.number().int().nonnegative(),
      }),
      summary: z.object({
        finding_count: z.number().int().nonnegative(),
        error_count: z.number().int().nonnegative(),
        warning_count: z.number().int().nonnegative(),
        info_count: z.number().int().nonnegative(),
        imported_net_count: z.number().int().nonnegative(),
        aliased_net_count: z.number().int().nonnegative(),
        unannotated_component_count: z.number().int().nonnegative(),
        missing_footprint_count: z.number().int().nonnegative(),
        missing_value_count: z.number().int().nonnegative(),
        duplicate_reference_count: z.number().int().nonnegative(),
        ambiguous_bom_count: z.number().int().nonnegative(),
        unresolved_expression_count: z.number().int().nonnegative(),
      }),
      findings: z.array(
        z.object({
          code: z.string(),
          severity: z.enum(['info', 'warning', 'error']),
          message: z.string(),
          component_id: z.string().optional(),
          component_ref: z.string().optional(),
          net_name: z.string().optional(),
          raw_net_names: z.array(z.string()).optional(),
          evidence: z.record(z.string(), z.unknown()).optional(),
          suggested_action: z.string(),
          confidence: z.enum(['high', 'medium', 'low']),
        }),
      ),
      normalization_preview: z.object({
        net_aliases: z.array(
          z.object({
            canonical_net_name: z.string(),
            raw_net_names: z.array(z.string()),
            kind: z.enum(['signal', 'power', 'ground', 'power-flag', 'unnamed']),
            rules: z.array(z.string()),
          }),
        ),
        component_repairs: z.array(
          z.object({
            component_id: z.string(),
            reference: z.string(),
            actions: z.array(
              z.enum([
                'annotate-reference',
                'assign-footprint',
                'assign-value',
                'resolve-value-expression',
                'resolve-footprint-expression',
                'review-bom-classification',
              ]),
            ),
          }),
        ),
      }),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, includeInfo, componentLimit } = params as {
        projectId: string;
        includeInfo: boolean;
        componentLimit: number;
      };
      try {
        const [componentResult, netResult] = await Promise.all([
          ctx.bridge.call('schematic.listComponents', {
            projectId,
            limit: componentLimit,
            offset: 0,
          }),
          ctx.bridge.call('schematic.listNets', { projectId }),
        ]);
        const componentData = componentResult as {
          total?: number;
          items?: Array<Record<string, unknown>>;
        };
        const components = componentData.items ?? [];
        const nets = Array.isArray(netResult) ? (netResult as Array<Record<string, unknown>>) : [];
        const componentTotal = componentData.total ?? components.length;
        const model = buildCanonicalSchematicModel({
          document: { projectId },
          components,
          nets,
        });
        const sourceTruncated = componentTotal > components.length;
        const audit = auditImportedDesign(model, { includeInfo, sourceTruncated });

        return {
          project_id: projectId,
          audit_schema_version: audit.schemaVersion,
          status: audit.status,
          read_only: true as const,
          safe_to_normalize: audit.safeToNormalize,
          source: {
            component_total: componentTotal,
            component_items_read: components.length,
            net_items_read: nets.length,
            source_truncated: sourceTruncated,
          },
          model_summary: {
            component_count: audit.modelSummary.componentCount,
            bom_component_count: audit.modelSummary.bomComponentCount,
            electrical_component_count: audit.modelSummary.electricalComponentCount,
            net_count: audit.modelSummary.netCount,
            imported_component_count: audit.modelSummary.importedComponentCount,
          },
          summary: {
            finding_count: audit.summary.findingCount,
            error_count: audit.summary.errorCount,
            warning_count: audit.summary.warningCount,
            info_count: audit.summary.infoCount,
            imported_net_count: audit.summary.importedNetCount,
            aliased_net_count: audit.summary.aliasedNetCount,
            unannotated_component_count: audit.summary.unannotatedComponentCount,
            missing_footprint_count: audit.summary.missingFootprintCount,
            missing_value_count: audit.summary.missingValueCount,
            duplicate_reference_count: audit.summary.duplicateReferenceCount,
            ambiguous_bom_count: audit.summary.ambiguousBomCount,
            unresolved_expression_count: audit.summary.unresolvedExpressionCount,
          },
          findings: audit.findings.map((finding) => ({
            code: finding.code,
            severity: finding.severity,
            message: finding.message,
            component_id: finding.componentId,
            component_ref: finding.componentRef,
            net_name: finding.netName,
            raw_net_names: finding.rawNetNames,
            evidence: finding.evidence,
            suggested_action: finding.suggestedAction,
            confidence: finding.confidence,
          })),
          normalization_preview: {
            net_aliases: audit.normalizationPreview.netAliases.map((alias) => ({
              canonical_net_name: alias.canonicalNetName,
              raw_net_names: alias.rawNetNames,
              kind: alias.kind,
              rules: alias.rules,
            })),
            component_repairs: audit.normalizationPreview.componentRepairs.map((repair) => ({
              component_id: repair.componentId,
              reference: repair.reference,
              actions: repair.actions,
            })),
          },
        };
      } catch (err) {
        return {
          project_id: projectId,
          audit_schema_version: 'imported-design-audit/v1' as const,
          status: 'blocked' as const,
          read_only: true as const,
          safe_to_normalize: false,
          source: {
            component_total: 0,
            component_items_read: 0,
            net_items_read: 0,
            source_truncated: true,
          },
          model_summary: {
            component_count: 0,
            bom_component_count: 0,
            electrical_component_count: 0,
            net_count: 0,
            imported_component_count: 0,
          },
          summary: {
            finding_count: 0,
            error_count: 0,
            warning_count: 0,
            info_count: 0,
            imported_net_count: 0,
            aliased_net_count: 0,
            unannotated_component_count: 0,
            missing_footprint_count: 0,
            missing_value_count: 0,
            duplicate_reference_count: 0,
            ambiguous_bom_count: 0,
            unresolved_expression_count: 0,
          },
          findings: [],
          normalization_preview: { net_aliases: [], component_repairs: [] },
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_preview_imported_normalization',
    title: 'Preview imported schematic normalization',
    description:
      'Read the live schematic and produce a deterministic, read-only normalization plan with a ' +
      'stable plan ID, model hash, proposed net-name/reference/metadata operations, validation ' +
      'gates, warnings, and blockers. This tool never writes to EasyEDA.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: importedNormalizationPreviewInputSchema,
    outputSchema: z.object({
      project_id: z.string(),
      source: z.object({
        component_total: z.number().int().nonnegative(),
        component_items_read: z.number().int().nonnegative(),
        net_items_read: z.number().int().nonnegative(),
        source_truncated: z.boolean(),
      }),
      plan: ImportedNormalizationPlanSchema,
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const {
        projectId,
        componentLimit,
        normalizeNetNames,
        annotateReferences,
        resolveMetadataExpressions,
        componentOverrides,
      } = params as z.infer<typeof importedNormalizationPreviewInputSchema>;
      const planOptions = {
        normalizeNetNames,
        annotateReferences,
        resolveMetadataExpressions,
        componentOverrides,
      };

      try {
        const [componentResult, netResult] = await Promise.all([
          ctx.bridge.call('schematic.listComponents', {
            projectId,
            limit: componentLimit,
            offset: 0,
          }),
          ctx.bridge.call('schematic.listNets', { projectId }),
        ]);
        const componentData = Array.isArray(componentResult)
          ? {
              total: componentResult.length,
              items: componentResult as Array<Record<string, unknown>>,
            }
          : (componentResult as {
              total?: number;
              items?: Array<Record<string, unknown>>;
            });
        const components = componentData.items ?? [];
        const netData = Array.isArray(netResult)
          ? (netResult as Array<Record<string, unknown>>)
          : ((netResult as { items?: Array<Record<string, unknown>> } | null)?.items ?? []);
        const componentTotal = componentData.total ?? components.length;
        const sourceTruncated = componentTotal > components.length;
        const model = buildCanonicalSchematicModel({
          document: { projectId },
          components,
          nets: netData,
        });
        const plan = previewImportedNormalization(model, {
          ...planOptions,
          sourceTruncated,
        });

        return {
          project_id: projectId,
          source: {
            component_total: componentTotal,
            component_items_read: components.length,
            net_items_read: netData.length,
            source_truncated: sourceTruncated,
          },
          plan,
        };
      } catch (err) {
        const plan = previewImportedNormalization(
          buildCanonicalSchematicModel({ document: { projectId } }),
          {
            ...planOptions,
            sourceTruncated: true,
          },
        );
        return {
          project_id: projectId,
          source: {
            component_total: 0,
            component_items_read: 0,
            net_items_read: 0,
            source_truncated: true,
          },
          plan,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerSchematicReadTools };
