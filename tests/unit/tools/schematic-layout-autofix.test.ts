import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerSchematicLayoutTools } from '../../../src/tools/L2_schematic_layout.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';

describe('easyeda_schematic_layout_autofix', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerSchematicLayoutTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'pro',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  it('is registered as a read-only, confirmWrite:false tool', () => {
    const tool = registry.get('easyeda_schematic_layout_autofix');
    expect(tool?.confirmWrite).toBe(false);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('reports no violations or moves for a clean, title-block-clear component', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo')
        return { pageSize: { width: 1000, height: 700, unit: 'mil' } };
      if (method === 'schematic.listComponents')
        return {
          total: 1,
          items: [
            {
              primitiveId: 'component-r1',
              reference: 'R1',
              component_kind: 'part',
              x: 100,
              y: -300,
            },
          ],
        };
      if (method === 'schematic.primitiveBounds')
        // buildEngineSheetGeometry puts the sheet's y-range at [-700, 0] for a
        // 700-tall page (top edge at y=0), so a component fully "on the page"
        // needs negative y here, not positive.
        return {
          items: [
            {
              primitiveId: 'component-r1',
              bounds: { minX: 100, maxX: 140, minY: -310, maxY: -290 },
            },
          ],
        };
      throw new Error(`Unexpected method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_layout_autofix')?.handler(context, {
      projectId: 'project-1',
    });

    expect(result).toMatchObject({
      projectId: 'project-1',
      mode: 'preview',
      requiresConfirmWrite: true,
      violations: [],
      moves: [],
      primitiveCount: 1,
      unavailablePrimitiveIds: [],
      allowlist: { primitiveTypes: ['component'], properties: ['position'] },
    });
    expect(bridgeCall).toHaveBeenCalledWith('schematic.primitiveBounds', {
      primitiveIds: ['component-r1'],
    });
  });

  it('detects TITLE_BLOCK_OVERLAP and proposes a cosmetic move that resolves it', async () => {
    // For a 1000x700 mil sheet, buildEngineSheetGeometry's title block keepout
    // is {x: 550, y: -182, width: 450, height: 182} -- a component fully
    // inside that box overlaps the title block.
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo')
        return { pageSize: { width: 1000, height: 700, unit: 'mil' } };
      if (method === 'schematic.listComponents')
        return {
          total: 1,
          items: [
            {
              primitiveId: 'component-u1',
              reference: 'U1',
              component_kind: 'part',
              x: 600,
              y: -100,
            },
          ],
        };
      if (method === 'schematic.primitiveBounds')
        return {
          items: [
            {
              primitiveId: 'component-u1',
              bounds: { minX: 600, maxX: 640, minY: -100, maxY: -80 },
            },
          ],
        };
      throw new Error(`Unexpected method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_layout_autofix')?.handler(context, {
      projectId: 'project-1',
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ code: 'TITLE_BLOCK_OVERLAP' });
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]).toMatchObject({ primitiveId: 'component-u1', property: 'position' });
    expect(result.report.remaining).toEqual([]);
  });

  it('reports components with unavailable bounds separately, not as autofix primitives', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo')
        return { pageSize: { width: 1000, height: 700, unit: 'mil' } };
      if (method === 'schematic.listComponents')
        return {
          total: 1,
          items: [
            {
              primitiveId: 'component-r1',
              reference: 'R1',
              component_kind: 'part',
              x: 100,
              y: 100,
            },
          ],
        };
      if (method === 'schematic.primitiveBounds') return { items: [] };
      throw new Error(`Unexpected method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_layout_autofix')?.handler(context, {
      projectId: 'project-1',
    });

    expect(result.primitiveCount).toBe(0);
    expect(result.unavailablePrimitiveIds).toEqual(['component-r1']);
    expect(result.violations).toEqual([]);
  });

  it('honors a caller-supplied allowlist instead of the component/position default', async () => {
    // Every live primitive is reported as primitiveType 'component' (see
    // gatherLiveLayoutAutofixPreview), so an allowlist that only admits
    // 'text' primitives excludes it -- schema-legal (inputSchema requires
    // .min(1) per array) but effectively empty for this primitive set.
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo')
        return { pageSize: { width: 1000, height: 700, unit: 'mil' } };
      if (method === 'schematic.listComponents')
        return {
          total: 1,
          items: [
            {
              primitiveId: 'component-u1',
              reference: 'U1',
              component_kind: 'part',
              x: 600,
              y: -100,
            },
          ],
        };
      if (method === 'schematic.primitiveBounds')
        return {
          items: [
            {
              primitiveId: 'component-u1',
              bounds: { minX: 600, maxX: 640, minY: -100, maxY: -80 },
            },
          ],
        };
      throw new Error(`Unexpected method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_layout_autofix')?.handler(context, {
      projectId: 'project-1',
      allowlist: { primitiveTypes: ['text'], properties: ['position'] },
    });

    expect(result.allowlist).toEqual({ primitiveTypes: ['text'], properties: ['position'] });
    expect(result.violations).toHaveLength(1);
    expect(result.moves).toEqual([]);
    expect(result.report.remaining).toEqual([result.violations[0].id]);
  });

  it('rejects an allowlist with an empty primitiveTypes or properties array via the input schema', () => {
    const tool = registry.get('easyeda_schematic_layout_autofix');
    const parsed = tool?.inputSchema?.safeParse({
      projectId: 'project-1',
      allowlist: { primitiveTypes: [], properties: [] },
    });
    expect(parsed?.success).toBe(false);
  });
});
