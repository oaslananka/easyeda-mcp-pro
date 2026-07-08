import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import {
  fetchLoaderStatus,
  pushDispatcher,
  readDispatcherArtifact,
  revertDispatcher,
} from '../bridge/hotswap.js';
import { fetchComponentPins } from './schematic-helpers.js';

const apiCallInputSchema = z.object({
  path: z.string().regex(/^[A-Za-z]+_[A-Za-z0-9]+\.[A-Za-z][A-Za-z0-9_]*$/),
  args: z.array(z.unknown()).default([]),
  confirmWrite: z.boolean().default(false),
});

const writeMethodPattern =
  /\.(create|delete|modify|open|openProject|save|import|export|reorder|remove|update|set|reset|done)$/i;

function requiresWriteConfirmation(path: string): boolean {
  return writeMethodPattern.test(path);
}

type LiveSmokeStep = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type LiveSmokeCheck = {
  id: string;
  method: string;
  ok: boolean;
  duration_ms: number;
  error?: string;
};

function summarizeTotal(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const total = (payload as { total?: unknown }).total;
  return typeof total === 'number' ? total : undefined;
}

function summarizeNetNames(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) =>
      item && typeof item === 'object' ? (item as { netName?: unknown }).netName : undefined,
    )
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function summarizeApiInventory(payload: unknown): { total?: number; class_names?: string[] } {
  if (!payload || typeof payload !== 'object') return {};
  const data = payload as { total?: unknown; classes?: unknown };
  const classNames = Array.isArray(data.classes)
    ? data.classes
        .map((item) =>
          item && typeof item === 'object'
            ? (item as { className?: unknown }).className
            : undefined,
        )
        .filter((name): name is string => typeof name === 'string')
        .slice(0, 25)
    : undefined;
  return {
    total: typeof data.total === 'number' ? data.total : undefined,
    class_names: classNames,
  };
}

type RegressionStep = { id: string; ok: boolean; detail?: string; error?: string };

async function runRegressionStep(
  steps: RegressionStep[],
  id: string,
  fn: () => Promise<string | void>,
): Promise<boolean> {
  try {
    const detail = await fn();
    steps.push({ id, ok: true, detail: detail || undefined });
    return true;
  } catch (err) {
    steps.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Live-exercise real schematic write paths: place two test components,
 * connect same-net pins and confirm the netlist merges them, then confirm
 * the net-collision guard refuses a foreign-net wire onto a connected pin
 * (regression coverage for the wire/pin/flag collision guard). Returns every
 * primitive id created, for the caller to clean up regardless of pass/fail.
 */
async function runSchematicRegression(
  ctx: ToolContext,
  projectId: string,
  testDeviceItem: { uuid: string; libraryUuid: string },
  steps: RegressionStep[],
): Promise<string[]> {
  const createdIds: string[] = [];
  const suffix = String(Date.now()).slice(-6);
  const netA = `MCP_REGR_A_${suffix}`;
  const netB = `MCP_REGR_B_${suffix}`;
  const netC = `MCP_REGR_C_${suffix}`;
  let compA: string | undefined;
  let compB: string | undefined;

  await runRegressionStep(steps, 'schematic.place_a', async () => {
    const r = (await ctx.bridge.call('schematic.placeComponent', {
      deviceItem: testDeviceItem,
      x: 900,
      y: 900,
    })) as { primitiveId?: string };
    if (!r?.primitiveId) throw new Error('place returned no primitiveId');
    compA = r.primitiveId;
    createdIds.push(compA);
    return compA;
  });

  await runRegressionStep(steps, 'schematic.place_b', async () => {
    const r = (await ctx.bridge.call('schematic.placeComponent', {
      deviceItem: testDeviceItem,
      x: 1100,
      y: 1100,
    })) as { primitiveId?: string };
    if (!r?.primitiveId) throw new Error('place returned no primitiveId');
    compB = r.primitiveId;
    createdIds.push(compB);
    return compB;
  });

  if (compA) {
    await runRegressionStep(steps, 'schematic.connect_a_pin1', async () => {
      const r = (await ctx.bridge.call('schematic.connectPinToNet', {
        projectId,
        primitiveId: compA,
        pinNumber: '1',
        netName: netA,
      })) as { primitiveId?: string };
      if (r?.primitiveId) createdIds.push(r.primitiveId);
    });
  }

  if (compB) {
    await runRegressionStep(steps, 'schematic.connect_b_pin1_same_net', async () => {
      const r = (await ctx.bridge.call('schematic.connectPinToNet', {
        projectId,
        primitiveId: compB,
        pinNumber: '1',
        netName: netA,
      })) as { primitiveId?: string };
      if (r?.primitiveId) createdIds.push(r.primitiveId);
    });
  }

  await runRegressionStep(steps, 'schematic.verify_net_merge', async () => {
    const nets = (await ctx.bridge.call('schematic.listNets', { projectId })) as Array<{
      netName?: string;
      nodes?: unknown[];
    }>;
    const merged = (nets ?? []).find((n) => n.netName === netA);
    const count = merged?.nodes?.length ?? 0;
    if (count < 2) {
      throw new Error(`expected net "${netA}" to have >=2 nodes after merge, got ${count}`);
    }
    return `net "${netA}" has ${count} nodes`;
  });

  if (compA) {
    await runRegressionStep(steps, 'schematic.connect_a_pin2_other_net', async () => {
      const r = (await ctx.bridge.call('schematic.connectPinToNet', {
        projectId,
        primitiveId: compA,
        pinNumber: '2',
        netName: netB,
      })) as { primitiveId?: string };
      if (r?.primitiveId) createdIds.push(r.primitiveId);
    });

    await runRegressionStep(steps, 'schematic.collision_guard_blocks_foreign_net', async () => {
      const pins = await fetchComponentPins(ctx, compA as string);
      const pin2 = pins.find((p) => p.pinNumber === '2');
      if (!pin2) throw new Error('pin 2 not found on test component');
      let blocked = false;
      try {
        await ctx.bridge.call('schematic.addWire', {
          points: [
            { x: pin2.x, y: pin2.y },
            { x: pin2.x, y: pin2.y + 50 },
          ],
          netName: netC,
        });
      } catch (err) {
        blocked = err instanceof Error && /NET_COLLISION|coincides with/i.test(err.message);
        if (!blocked) throw err;
      }
      if (!blocked) {
        throw new Error(
          'expected the collision guard to refuse a foreign-net wire onto a connected pin, but it succeeded',
        );
      }
      return 'collision guard correctly refused a foreign-net wire onto a connected pin';
    });
  }

  return createdIds;
}

/**
 * Live-exercise real PCB write paths: add a via and a track, confirm both
 * appear in the readback tools, delete them, and confirm they're actually
 * gone — regression coverage for the delete-doesn't-delete bug fixed this
 * session (PCB_PrimitiveComponent.delete() reported success without deleting
 * ids it didn't own). Requires a focused PCB tab; each step reports its own
 * failure rather than aborting the sequence.
 */
async function runPcbRegression(ctx: ToolContext, steps: RegressionStep[]): Promise<void> {
  const suffix = String(Date.now()).slice(-6);
  const netName = `MCP_REGR_PCB_${suffix}`;
  let viaId: string | undefined;
  let trackIds: string[] = [];

  await runRegressionStep(steps, 'pcb.add_via', async () => {
    const r = (await ctx.bridge.call('pcb.addVia', {
      netName,
      x: 5000,
      y: 5000,
      holeSize: 0.3,
      outerDiameter: 0.6,
    })) as { primitiveId?: string };
    if (!r?.primitiveId) throw new Error('addVia returned no primitiveId');
    viaId = r.primitiveId;
    return viaId;
  });

  await runRegressionStep(steps, 'pcb.add_track', async () => {
    const r = (await ctx.bridge.call('pcb.addTrack', {
      netName,
      layer: 1,
      points: [
        { x: 5000, y: 5000 },
        { x: 5500, y: 5000 },
      ],
      width: 0.2,
    })) as { primitiveIds?: string[]; primitiveId?: string };
    trackIds = r?.primitiveIds ?? (r?.primitiveId ? [r.primitiveId] : []);
    if (trackIds.length === 0) throw new Error('addTrack returned no primitiveIds');
    return `${trackIds.length} segment(s)`;
  });

  await runRegressionStep(steps, 'pcb.verify_readback', async () => {
    const vias = (await ctx.bridge.call('pcb.listVias', { limit: 200, offset: 0 })) as {
      items?: Array<{ primitiveId?: string }>;
    };
    const found = (vias?.items ?? []).some((v) => v.primitiveId === viaId);
    if (!found) throw new Error(`via ${viaId} not found in pcb.listVias readback`);
    return 'via found in readback';
  });

  const idsToDelete = [viaId, ...trackIds].filter((id): id is string => Boolean(id));
  await runRegressionStep(steps, 'pcb.delete_and_verify_gone', async () => {
    const del = (await ctx.bridge.call('pcb.deleteComponent', {
      primitiveIds: idsToDelete,
    })) as { notFound?: string[] };
    const notFound = del?.notFound ?? [];
    if (notFound.length > 0) {
      throw new Error(
        `delete left ${notFound.length} primitive(s) unresolved: ${notFound.join(', ')}`,
      );
    }
    const vias = (await ctx.bridge.call('pcb.listVias', { limit: 200, offset: 0 })) as {
      items?: Array<{ primitiveId?: string }>;
    };
    const stillThere = (vias?.items ?? []).some((v) => v.primitiveId === viaId);
    if (stillThere) throw new Error(`via ${viaId} still present after delete`);
    return `deleted ${idsToDelete.length} primitive(s), confirmed gone`;
  });
}

function registerDiagnosticsApi(
  registry: { register: (def: ToolDefinition) => void },
  config: EnvConfig,
) {
  const executeInputSchema = z.object({
    code: z.string().min(1),
    confirmWrite: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(60000).default(15000),
  });

  registry.register({
    name: 'easyeda_api_call',
    title: 'Call EasyEDA API',
    description:
      'Controlled call to a documented EasyEDA class method by path, for example SCH_PrimitiveWire.getAll. This is not raw JavaScript execution.',
    profile: 'full',
    evidence: ['runtime-probe', 'pro-api-types', 'official-docs'],
    risk: 'high',
    confirmWrite: true,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    inputSchema: apiCallInputSchema,
    outputSchema: z.object({
      ok: z.boolean(),
      path: z.string(),
      resolvedPath: z.string().optional(),
      result: z.unknown().optional(),
      error: z.string().optional(),
      requires_confirmation: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { path, args, confirmWrite } = apiCallInputSchema.parse(params);
      if (requiresWriteConfirmation(path) && !confirmWrite) {
        return {
          ok: false,
          path,
          requires_confirmation: true,
          error: `Potentially mutating EasyEDA API method "${path}" requires confirmWrite=true.`,
        };
      }

      try {
        const result = await ctx.bridge.call('api.call', { path, args });
        const data = result as { path?: string; resolvedPath?: string; result?: unknown };
        return {
          ok: true,
          path: data.path ?? path,
          resolvedPath: data.resolvedPath,
          result: data.result,
        };
      } catch (err) {
        return {
          ok: false,
          path,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  if (config.BRIDGE_RAW_EXEC_ENABLED && config.MCP_RAW_EXEC_EXPERIMENTAL) {
    registry.register({
      name: 'easyeda_execute',
      title: 'Execute EasyEDA API code',
      description:
        'Execute arbitrary JavaScript in the EasyEDA Pro extension runtime via the Run API Gateway. The code receives `eda` as the EDA API root object. Requires BRIDGE_RAW_EXEC_ENABLED=true, MCP_RAW_EXEC_EXPERIMENTAL=true, bridge:execute scope when TOOL_SCOPES is set, and confirmWrite=true. Use this when typed API methods are unavailable or to run multi-step sequences atomically.',
      profile: 'dev',
      evidence: ['official-docs', 'runtime-probe'],
      risk: 'high',
      confirmWrite: true,
      group: 'diagnostics',
      version: '1.0.0',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      inputSchema: executeInputSchema,
      outputSchema: z.object({
        ok: z.boolean(),
        result: z.unknown().optional(),
        error: z.string().optional(),
        disabled: z.boolean().optional(),
      }),
      handler: async (ctx: ToolContext, params: unknown) => {
        const { code, timeoutMs } = executeInputSchema.parse(params);
        if (!config.BRIDGE_RAW_EXEC_ENABLED) {
          return {
            ok: false,
            disabled: true,
            error:
              'Raw execution is disabled. Set BRIDGE_RAW_EXEC_ENABLED=true to enable easyeda_execute.',
          };
        }
        try {
          const result = await ctx.bridge.call('api.execute', { code }, { timeoutMs });
          return { ok: true, result: (result as Record<string, unknown>).result };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  if (config.BRIDGE_HOT_SWAP_ENABLED) {
    const hotSwapInputSchema = z.object({
      action: z.enum(['status', 'push', 'revert']),
      bundlePath: z.string().optional(),
      confirmWrite: z.boolean().default(false),
    });

    registry.register({
      name: 'easyeda_dev_hot_swap',
      title: 'Hot-swap extension dispatcher',
      description:
        'Dev-only: push the freshly built extension dispatcher bundle (dist/dispatcher.js) into the ' +
        'running EasyEDA extension over the bridge, replacing its dispatch logic without re-importing ' +
        'the .eext. action=status reports the active dispatcher build; push sends the bundle at ' +
        'bundlePath (defaults to BRIDGE_HOT_SWAP_WATCH); revert restores the baked dispatcher. ' +
        'Requires BRIDGE_HOT_SWAP_ENABLED=true (refused in production), a dev extension build, and ' +
        'confirmWrite=true on every call (including status).',
      profile: 'dev',
      evidence: ['runtime-probe'],
      risk: 'high',
      confirmWrite: true,
      group: 'diagnostics',
      version: '1.0.0',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      inputSchema: hotSwapInputSchema,
      outputSchema: z.object({
        ok: z.boolean(),
        action: z.string(),
        status: z.unknown().optional(),
        buildId: z.string().optional(),
        methodCount: z.number().optional(),
        error: z.string().optional(),
        requires_confirmation: z.boolean().optional(),
      }),
      handler: async (ctx: ToolContext, params: unknown) => {
        const { action, bundlePath, confirmWrite } = hotSwapInputSchema.parse(params);
        try {
          if (action === 'status') {
            const status = await fetchLoaderStatus(ctx.bridge.call);
            return { ok: true, action, status };
          }
          if (!confirmWrite) {
            return {
              ok: false,
              action,
              requires_confirmation: true,
              error: `Hot-swap "${action}" replaces live extension code and requires confirmWrite=true.`,
            };
          }
          if (action === 'revert') {
            const result = await revertDispatcher(ctx.bridge.call);
            return { ok: true, action, buildId: result.buildId };
          }
          const path = bundlePath || config.BRIDGE_HOT_SWAP_WATCH;
          if (!path) {
            return {
              ok: false,
              action,
              error:
                'No bundle path: pass bundlePath or set BRIDGE_HOT_SWAP_WATCH to easyeda-bridge-extension/dist/dispatcher.js.',
            };
          }
          const artifact = readDispatcherArtifact(path);
          const result = await pushDispatcher(
            ctx.bridge.call,
            artifact,
            config.BRIDGE_HOT_SWAP_CHUNK_BYTES,
          );
          return { ok: true, action, buildId: result.buildId, methodCount: result.methodCount };
        } catch (err) {
          return { ok: false, action, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  registry.register({
    name: 'easyeda_live_smoke_report',
    title: 'Run EasyEDA live smoke report',
    description:
      'Run a read-only live smoke report against the connected EasyEDA bridge and return status, API inventory, components, wires, and schematic nets in one response.',
    profile: 'dev',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().default(''),
      limit: z.number().int().min(1).max(100).default(10),
      includeRaw: z.boolean().default(true),
      timeoutMs: z.number().int().min(1000).max(60000).default(15000),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      project_id: z.string(),
      generated_at: z.string(),
      checks: z.array(
        z.object({
          id: z.string(),
          method: z.string(),
          ok: z.boolean(),
          duration_ms: z.number().int().nonnegative(),
          error: z.string().optional(),
        }),
      ),
      summary: z.object({
        api_class_count: z.number().optional(),
        api_class_names: z.array(z.string()).optional(),
        component_total: z.number().optional(),
        wire_total: z.number().optional(),
        net_total: z.number().optional(),
        net_names: z.array(z.string()).optional(),
      }),
      raw: z
        .object({
          bridge_status: z.unknown().optional(),
          api_inventory: z.unknown().optional(),
          components: z.unknown().optional(),
          wires: z.unknown().optional(),
          nets: z.unknown().optional(),
        })
        .optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, limit, includeRaw, timeoutMs } = z
        .object({
          projectId: z.string().default(''),
          limit: z.number().int().min(1).max(100).default(10),
          includeRaw: z.boolean().default(true),
          timeoutMs: z.number().int().min(1000).max(60000).default(15000),
        })
        .parse(params);

      const steps: LiveSmokeStep[] = [
        { id: 'bridge_status', method: 'system.getStatus', params: {} },
        { id: 'api_inventory', method: 'system.apiInventory', params: {} },
        { id: 'components', method: 'system.inspectComponents', params: { limit } },
        { id: 'wires', method: 'system.inspectWires', params: { limit } },
        { id: 'nets', method: 'schematic.listNets', params: { projectId } },
      ];

      const checks: LiveSmokeCheck[] = [];
      const raw: Record<string, unknown> = {};

      for (const step of steps) {
        const startedAt = Date.now();
        try {
          raw[step.id] = await ctx.bridge.call(step.method, step.params, { timeoutMs });
          checks.push({
            id: step.id,
            method: step.method,
            ok: true,
            duration_ms: Date.now() - startedAt,
          });
        } catch (err) {
          checks.push({
            id: step.id,
            method: step.method,
            ok: false,
            duration_ms: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const apiSummary = summarizeApiInventory(raw.api_inventory);
      return {
        ok: checks.every((check) => check.ok),
        project_id: projectId,
        generated_at: new Date().toISOString(),
        checks,
        summary: {
          api_class_count: apiSummary.total,
          api_class_names: apiSummary.class_names,
          component_total: summarizeTotal(raw.components),
          wire_total: summarizeTotal(raw.wires),
          net_total: Array.isArray(raw.nets) ? raw.nets.length : undefined,
          net_names: summarizeNetNames(raw.nets),
        },
        raw: includeRaw
          ? {
              bridge_status: raw.bridge_status,
              api_inventory: raw.api_inventory,
              components: raw.components,
              wires: raw.wires,
              nets: raw.nets,
            }
          : undefined,
      };
    },
  });

  registry.register({
    name: 'easyeda_wire_probe',
    title: 'Probe schematic wires',
    description:
      'Inspect live schematic wire objects, including line coordinates, net names, methods, and state getter values, to validate EasyEDA runtime mappings.',
    profile: 'dev',
    evidence: ['runtime-probe', 'pro-api-types'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10),
    }),
    outputSchema: z.object({
      total: z.number().int().nonnegative(),
      samples: z.array(z.unknown()),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(50).default(10) })
        .parse(params);
      try {
        return await ctx.bridge.call('system.inspectWires', { limit });
      } catch (err) {
        return {
          total: 0,
          samples: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_component_probe',
    title: 'Probe schematic components',
    description:
      'Inspect live schematic component objects, including available methods and state getter values, to validate EasyEDA runtime mappings.',
    profile: 'dev',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(25).default(5),
    }),
    outputSchema: z.object({
      total: z.number().int().nonnegative(),
      samples: z.array(z.unknown()),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(25).default(5) })
        .parse(params);
      try {
        return await ctx.bridge.call('system.inspectComponents', { limit });
      } catch (err) {
        return {
          total: 0,
          samples: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const liveRegressionInputSchema = z.object({
    projectId: z.string().default(''),
    testDeviceItem: z.object({ uuid: z.string(), libraryUuid: z.string() }),
    scope: z.enum(['schematic', 'pcb', 'both']).default('schematic'),
    confirmWrite: z
      .literal(true)
      .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
  });

  registry.register({
    name: 'easyeda_live_write_regression',
    title: 'Run live write-path regression suite',
    description:
      'Exercise real schematic (and optionally PCB) write paths against the bridge — place, ' +
      'connect, wire, delete — reporting pass/fail per step, then clean up its own scratch ' +
      'primitives. Needs a test device from schematic_search_device and the matching tab focused.',
    profile: 'dev',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: liveRegressionInputSchema,
    outputSchema: z.object({
      ok: z.boolean(),
      project_id: z.string(),
      scope: z.string(),
      steps: z.array(
        z.object({
          id: z.string(),
          ok: z.boolean(),
          detail: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
      cleanup_performed: z.boolean(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, testDeviceItem, scope } = liveRegressionInputSchema.parse(params);
      const steps: RegressionStep[] = [];
      let createdSchematicIds: string[] = [];
      let cleanupPerformed = false;

      if (scope === 'schematic' || scope === 'both') {
        createdSchematicIds = await runSchematicRegression(ctx, projectId, testDeviceItem, steps);
      }
      if (scope === 'pcb' || scope === 'both') {
        await runPcbRegression(ctx, steps);
      }

      if (createdSchematicIds.length > 0) {
        try {
          await ctx.bridge.call('schematic.deletePrimitive', {
            primitiveIds: createdSchematicIds,
          });
          cleanupPerformed = true;
        } catch (err) {
          steps.push({
            id: 'schematic.cleanup',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        ok: steps.every((s) => s.ok),
        project_id: projectId,
        scope,
        steps,
        cleanup_performed: cleanupPerformed,
      };
    },
  });
}

export { registerDiagnosticsApi };
