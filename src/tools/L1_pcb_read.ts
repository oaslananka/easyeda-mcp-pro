import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

const pcbListInputSchema = z.object({
  projectId: z.string(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Shared handler for the three PCB list-* tools: call the bridge, map its
 *  {total, items} shape onto the caller-provided list key, and degrade to
 *  an empty (not_available) list instead of throwing — "no PCB tab focused"
 *  is a normal state for these tools, not an error. */
function makePcbListHandler(bridgeMethod: string, listKey: string) {
  return async (ctx: ToolContext, params: unknown) => {
    const { projectId, limit, offset } = pcbListInputSchema.parse(params);
    try {
      const result = await ctx.bridge.call<
        Record<string, unknown>,
        { total?: number; items?: Record<string, unknown>[] }
      >(bridgeMethod, { limit, offset });
      return {
        project_id: projectId,
        [listKey]: result?.items ?? [],
        total: result?.total ?? result?.items?.length ?? 0,
      };
    } catch (err) {
      return {
        project_id: projectId,
        [listKey]: [],
        total: 0,
        not_available: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

function registerPcbReadTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_pcb_components',
    title: 'List PCB components',
    description:
      'List components placed on the active PCB layout: primitiveId, designator, footprint ' +
      'identity, position/rotation/layer. Requires a focused PCB tab in EasyEDA Pro — returns ' +
      'an empty list (not an error) if none is active.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'board',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: pcbListInputSchema,
    outputSchema: z.object({
      project_id: z.string(),
      components: z.array(
        z.object({
          primitiveId: z.string().optional(),
          designator: z.string().optional(),
          footprintName: z.string().optional(),
          footprintUuid: z.string().optional(),
          footprintLibraryUuid: z.string().optional(),
          deviceName: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          rotation: z.number().optional(),
          layer: z.number().optional(),
          locked: z.boolean().optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: makePcbListHandler('pcb.listComponents', 'components'),
  });

  registry.register({
    name: 'easyeda_pcb_tracks',
    title: 'List PCB tracks',
    description:
      'List copper track segments on the active PCB layout: primitiveId, net, layer, start/end ' +
      'coordinates, width. A multi-point track drawn by add_track appears as several consecutive ' +
      'segments sharing one net. Returns an empty list (not an error) if no PCB tab is focused.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'board',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: pcbListInputSchema,
    outputSchema: z.object({
      project_id: z.string(),
      tracks: z.array(
        z.object({
          primitiveId: z.string().optional(),
          net: z.string().optional(),
          layer: z.number().optional(),
          startX: z.number().optional(),
          startY: z.number().optional(),
          endX: z.number().optional(),
          endY: z.number().optional(),
          width: z.number().optional(),
          locked: z.boolean().optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: makePcbListHandler('pcb.listTracks', 'tracks'),
  });

  registry.register({
    name: 'easyeda_pcb_vias',
    title: 'List PCB vias',
    description:
      'List vias on the active PCB layout: primitiveId, net, position, hole/outer diameter ' +
      '(native unit, same scale as x/y — not independently verified against a known physical ' +
      'dimension). Requires a focused PCB tab — returns an empty list (not an error) if none is active.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'board',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: pcbListInputSchema,
    outputSchema: z.object({
      project_id: z.string(),
      vias: z.array(
        z.object({
          primitiveId: z.string().optional(),
          net: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          holeDiameter: z.number().optional(),
          diameter: z.number().optional(),
          locked: z.boolean().optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: makePcbListHandler('pcb.listVias', 'vias'),
  });
}

export { registerPcbReadTools };
