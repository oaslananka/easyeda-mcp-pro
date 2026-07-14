import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerAutoroutingTools } from '../../../src/tools/L2_autorouting.js';
import { EnvSchema } from '../../../src/config/env.js';

const validCircuitIR = {
  metadata: {},
  devices: [{ id: 'dev-u1', ref: 'U1' }],
};

function passingBoardData() {
  return {
    widthMm: 60,
    heightMm: 40,
    layerCount: 2,
    hasOutline: true,
    mountingHoleCount: 4,
    hasLayerStack: true,
    hasNetClasses: true,
    hasClearanceRules: true,
    hasKeepoutAreas: true,
    hasPlacementZones: true,
    hasFiducials: true,
    hasTestPads: true,
    hasHighVoltage: false,
    manufacturingProcess: 'standard',
    hasQuantity: true,
  };
}

describe('Autorouting Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;
  let tmpArtifactDir: string;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerAutoroutingTools(registry, config);

    bridgeCall = vi.fn();
    tmpArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autorouting-tools-'));

    context = {
      profile: 'full',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: tmpArtifactDir,
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    } as unknown as ToolContext;
  });

  afterEach(() => {
    fs.rmSync(tmpArtifactDir, { recursive: true, force: true });
  });

  describe('easyeda_pcb_floorplan', () => {
    it('returns a structured error for invalid CircuitIR rather than throwing', async () => {
      const tool = registry.get('easyeda_pcb_floorplan');
      const result = (await tool?.handler(context, {
        circuitIR: { not: 'valid' },
        devices: [{ deviceId: 'x', ref: 'X', widthMm: 1, heightMm: 1 }],
        board: { widthMm: 100, heightMm: 80 },
        anchor: { x: 10, y: 10 },
        mode: 'preview',
      })) as any;
      expect(result.not_available).toBe(true);
      expect(result.blocked).toBe(true);
      expect(bridgeCall).not.toHaveBeenCalled();
    });

    it('preview mode returns a plan without calling the bridge', async () => {
      const tool = registry.get('easyeda_pcb_floorplan');
      const result = (await tool?.handler(context, {
        circuitIR: validCircuitIR,
        devices: [{ deviceId: 'dev-u1', ref: 'U1', widthMm: 5, heightMm: 5 }],
        board: { widthMm: 100, heightMm: 80 },
        anchor: { x: 10, y: 10 },
        mode: 'preview',
      })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.placements).toHaveLength(1);
    });

    it('blocks apply when confirmWrite is not true', async () => {
      const tool = registry.get('easyeda_pcb_floorplan');
      const result = (await tool?.handler(context, {
        circuitIR: validCircuitIR,
        devices: [
          { deviceId: 'dev-u1', ref: 'U1', primitiveId: 'pcb-u1', widthMm: 5, heightMm: 5 },
        ],
        board: { widthMm: 100, heightMm: 80 },
        anchor: { x: 10, y: 10 },
        mode: 'apply',
      })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.error).toMatch(/confirmWrite=true is required/);
    });

    it('blocks apply when a device has not been synced to an existing PCB primitive', async () => {
      const tool = registry.get('easyeda_pcb_floorplan');
      const result = (await tool?.handler(context, {
        circuitIR: validCircuitIR,
        devices: [{ deviceId: 'dev-u1', ref: 'U1', widthMm: 5, heightMm: 5 }],
        board: { widthMm: 100, heightMm: 80 },
        anchor: { x: 10, y: 10 },
        mode: 'apply',
        confirmWrite: true,
      })) as any;
      expect(result.applied).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'LAYOUT_COMPONENT_NOT_ON_BOARD' }),
        ]),
      );
      expect(bridgeCall).not.toHaveBeenCalled();
    });
  });

  describe('easyeda_pcb_autoroute', () => {
    it('blocks when confirmWrite is not true, without any bridge calls', async () => {
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;
      expect(bridgeCall).not.toHaveBeenCalled();
      expect(result.overall_verdict).toBe('blocked');
    });

    it('blocks on pre-flight constraint errors without calling the autorouter', async () => {
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        boardData: { hasOutline: false },
      })) as any;
      expect(result.blocked_by_preflight).toBe(true);
      expect(result.overall_verdict).toBe('blocked');
      expect(bridgeCall).not.toHaveBeenCalled();
    });

    it('reports failed (not silent success) when the autoroute bridge call throws', async () => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'api.call') throw new Error('PCB_Document.autoRouting not found');
        return {};
      });
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        boardData: passingBoardData(),
      })) as any;
      expect(result.overall_verdict).toBe('failed');
      expect(result.not_available).toBe(true);
      expect(result.success).toBe(false);
    });

    it('reports success with DRC/constraint-report evidence attached on a clean run', async () => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'api.call') {
          return {
            result: {
              success: true,
              totalNetsCount: 5,
              successNetsCount: 5,
              failedNets: [],
              duration: 120,
            },
          };
        }
        if (method === 'design.drc') {
          return {
            violations: [],
            totalViolations: 0,
            errorCount: 0,
            warningCount: 0,
            passed: true,
          };
        }
        if (method === 'board.getDimensions') return passingBoardData();
        if (method === 'board.listLayers') return [];
        if (method === 'board.getStackup') return { totalLayers: 2, layers: [] };
        return {};
      });
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        boardData: passingBoardData(),
      })) as any;
      expect(result.autoroute_result.total_nets_count).toBe(5);
      expect(result.post_route_drc.passed).toBe(true);
      expect(result.overall_verdict).not.toBe('failed');
      expect(result.overall_verdict).not.toBe('blocked');
    });

    it('reports partial when autoroute succeeds but post-route DRC finds violations', async () => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'api.call') {
          return {
            result: { success: true, totalNetsCount: 5, successNetsCount: 4, failedNets: ['NET1'] },
          };
        }
        if (method === 'design.drc') {
          return {
            violations: [{ severity: 'error' }],
            totalViolations: 1,
            errorCount: 1,
            warningCount: 0,
            passed: false,
          };
        }
        if (method === 'board.getDimensions') return passingBoardData();
        if (method === 'board.listLayers') return [];
        if (method === 'board.getStackup') return { totalLayers: 2, layers: [] };
        return {};
      });
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        boardData: passingBoardData(),
      })) as any;
      expect(result.overall_verdict).toBe('partial');
      expect(result.post_route_drc.passed).toBe(false);
    });
  });

  describe('easyeda_pcb_export_route_context', () => {
    it('writes the DSN file to the artifact directory on success', async () => {
      bridgeCall.mockResolvedValue({
        base64: Buffer.from('DSN-CONTENT').toString('base64'),
        fileName: 'board.dsn',
      });
      const tool = registry.get('easyeda_pcb_export_route_context');
      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;
      expect(result.exported).toBe(true);
      expect(result.artifact_path).toBeDefined();
      expect(fs.readFileSync(result.artifact_path, 'utf-8')).toBe('DSN-CONTENT');
    });

    it('reports not_available when the bridge returns no binary data', async () => {
      bridgeCall.mockResolvedValue({});
      const tool = registry.get('easyeda_pcb_export_route_context');
      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;
      expect(result.exported).toBe(false);
      expect(result.not_available).toBe(true);
    });

    it('reports not_available when the bridge call throws (e.g. method unsupported)', async () => {
      bridgeCall.mockRejectedValue(new Error('DSN export not supported in this EasyEDA version'));
      const tool = registry.get('easyeda_pcb_export_route_context');
      const result = (await tool?.handler(context, { projectId: 'proj-1' })) as any;
      expect(result.exported).toBe(false);
      expect(result.not_available).toBe(true);
      expect(result.error).toMatch(/not supported/);
    });
  });
});
