import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerSchematicLayoutTools } from '../../../src/tools/L2_schematic_layout.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';

describe('schematic layout tools', () => {
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

  it('collects geometry, topology, runtime checks, and visual evidence in one operation', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      switch (method) {
        case 'schematic.getSheetInfo':
          return { pageSize: { width: 1000, height: 700, unit: 'mil' } };
        case 'schematic.primitiveBounds':
          return {
            items: [
              {
                id: 'component-u1',
                primitiveType: 'component',
                ref: 'U1',
                combinedBounds: { x: 100, y: 200, width: 80, height: 60 },
                bodyBounds: { x: 100, y: 200, width: 80, height: 60 },
                geometrySource: 'runtime',
              },
            ],
          };
        case 'schematic.listNets':
          return [{ netName: 'GND', nodes: [{ component: 'U1', pin: '1' }] }];
        case 'system.inspectWires':
          return { samples: [] };
        case 'design.drc':
        case 'design.erc':
          return { totalViolations: 0, violations: [] };
        case 'canvas.captureRegion':
          return { base64: 'YQ==', mimeType: 'image/png' };
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    });
    const tool = registry.get('easyeda_schematic_layout_qa');

    const result = await tool?.handler(context, {
      projectId: 'project-1',
      expectedComponentRefs: ['U1'],
      expectedPinMappings: [{ componentRef: 'U1', pin: '1', netName: 'GND' }],
      runVisualCapture: true,
    });

    expect(result).toMatchObject({
      projectId: 'project-1',
      status: 'pass',
      passed: true,
      commitBlocked: false,
      evidence: {
        exactGeometry: true,
        runtimeDrc: true,
        runtimeErc: true,
        fullPageCapture: true,
        deterministicCapture: true,
      },
    });
    expect(bridgeCall).toHaveBeenCalledWith('schematic.primitiveBounds', {
      projectId: 'project-1',
    });
  });

  it('blocks a professional result when rendered bounds enter the title block', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo')
        return { pageSize: { width: 1000, height: 700, unit: 'mil' } };
      if (method === 'schematic.primitiveBounds')
        return {
          items: [
            {
              id: 'component-u1',
              primitiveType: 'component',
              ref: 'U1',
              combinedBounds: { x: 530, y: 100, width: 80, height: 80 },
              geometrySource: 'runtime',
            },
          ],
        };
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') return { samples: [] };
      if (method === 'design.drc' || method === 'design.erc') return { violations: [] };
      if (method === 'canvas.captureRegion') return { base64: 'YQ==' };
      throw new Error(`Unexpected method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_layout_qa')?.handler(context, {
      projectId: 'project-1',
      runVisualCapture: true,
    });

    expect(result?.status).toBe('fail');
    expect(result?.summary.criticalIssueCodes).toContain('TITLE_BLOCK_OVERLAP');
  });

  it('does not pass when complete rendered bounds are unavailable', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo')
        return { pageSize: { width: 1000, height: 700, unit: 'mil' } };
      if (method === 'schematic.primitiveBounds') throw new Error('METHOD_NOT_ALLOWED');
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') return { samples: [] };
      if (method === 'design.drc' || method === 'design.erc') return { violations: [] };
      throw new Error(`Unexpected method ${method}`);
    });

    const result = await registry.get('easyeda_schematic_layout_qa')?.handler(context, {
      projectId: 'project-1',
      runVisualCapture: false,
    });

    expect(result?.status).toBe('fail');
    expect(result?.commitBlocked).toBe(true);
    expect(result?.issues.map((issue: { code: string }) => issue.code)).toContain(
      'DOCUMENT_STATE_UNVERIFIED',
    );
  });
});
