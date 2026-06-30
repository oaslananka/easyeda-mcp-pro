import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

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
}

export { registerDiagnosticsApi };
