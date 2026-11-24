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
    hasDrillFile: true,
    copperToEdgeViolationCount: 0,
    minDrillMm: 0.3,
    minAnnularRingMm: 0.15,
    solderMaskSliverViolationCount: 0,
    silkscreenOverPadCount: 0,
    smtComponentCount: 4,
    fiducialCount: 3,
    toolingHoleCount: 2,
    polarizedComponentCount: 0,
    polarityMarkCount: 0,
    componentSpacingViolationCount: 0,
    criticalNetNames: [],
    testPointNets: [],
    requiresProgrammingHeader: false,
    hasFabricationNotes: true,
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
    it.each(['foreign-project', 'missing-identity'])(
      'refuses native autorouting without the requested PCB identity (%s)',
      async (scenario) => {
        bridgeCall.mockImplementation(async (method: string, params?: { path?: string }) => {
          if (method === 'system.getStatus')
            return { documentTargetGuard: true, documentProjectGuard: true };
          if (method === 'api.read') {
            if (scenario === 'missing-identity') return {};
            if (params?.path === 'DMT_Project.getCurrentProjectInfo')
              return { result: { uuid: 'foreign-project' } };
            return {
              result: {
                uuid: 'foreign-pcb',
                documentType: 3,
                parentProjectUuid: 'foreign-project',
              },
            };
          }
          if (method === 'api.call') return { result: { success: true } };
          return {};
        });
        const result = await registry.get('easyeda_pcb_autoroute')?.handler(context, {
          projectId: 'proj-1',
          confirmWrite: true,
          gateMode: 'warn',
          boardData: passingBoardData(),
        });
        expect(
          bridgeCall.mock.calls.some(
            ([method, params]) =>
              method === 'api.call' && params.path === 'PCB_Document.autoRouting',
          ),
        ).toBe(false);
        expect(result).toMatchObject({ success: false, overall_verdict: 'blocked' });
      },
    );

    function mockFocusedBridge(implementation: (method: string) => unknown = () => ({})) {
      bridgeCall.mockImplementation(async (method: string, params?: { path?: string }) => {
        if (method === 'system.getStatus')
          return { documentTargetGuard: true, documentProjectGuard: true };
        if (method === 'api.read')
          return {
            result:
              params?.path === 'DMT_Project.getCurrentProjectInfo'
                ? { uuid: 'proj-1' }
                : { uuid: 'pcb-1', parentProjectUuid: 'proj-1', documentType: 3 },
          };
        const response = await implementation(method);
        if (method === 'api.call')
          return {
            ...(response as object),
            targetDocument: {
              uuid: 'pcb-1',
              projectUuid: 'proj-1',
              name: 'PCB',
              documentType: 'pcb',
            },
          };
        return response;
      });
    }

    beforeEach(() => mockFocusedBridge());

    it.each([
      'old-extension',
      'wrong-pcb',
      'schematic-tab',
      'focus-changed',
      'caller-pcb',
      'caller-schematic',
    ])('refuses an unsafe autoroute target (%s)', async (scenario) => {
      let reads = 0;
      bridgeCall.mockImplementation(async (method: string, params?: { path?: string }) => {
        if (method === 'system.getStatus')
          return {
            documentTargetGuard: true,
            documentProjectGuard: scenario !== 'old-extension',
          };
        if (method === 'api.read') {
          if (params?.path === 'DMT_Project.getCurrentProjectInfo')
            return { result: { uuid: 'proj-1' } };
          reads++;
          return {
            result: {
              uuid:
                scenario === 'wrong-pcb' || (scenario === 'focus-changed' && reads > 1)
                  ? 'pcb-2'
                  : 'pcb-1',
              parentProjectUuid: 'proj-1',
              documentType: scenario === 'schematic-tab' ? 1 : 3,
            },
          };
        }
        return {};
      });
      const result = await registry.get('easyeda_pcb_autoroute')?.handler(context, {
        projectId: 'proj-1',
        ...(scenario === 'wrong-pcb' ? { expectedPcbUuid: 'pcb-1' } : {}),
        ...(scenario === 'caller-pcb' ? { expectedPcbUuid: 'pcb-2' } : {}),
        ...(scenario === 'caller-schematic' ? { expectedSchematicPageUuid: 'page-1' } : {}),
        confirmWrite: true,
        gateMode: 'warn',
        boardData: passingBoardData(),
      });
      expect(result).toMatchObject({ success: false, overall_verdict: 'blocked' });
      expect(bridgeCall.mock.calls.some(([method]) => method === 'api.call')).toBe(false);
    });

    it.each(['missing', 'foreign', 'no-success'])(
      'does not claim verified autoroute success from %s native response',
      async (scenario) => {
        const targetDocument = {
          uuid: 'pcb-1',
          projectUuid: 'proj-1',
          name: 'PCB',
          documentType: 'pcb',
        };
        bridgeCall.mockImplementation(async (method: string, params?: { path?: string }) => {
          if (method === 'system.getStatus')
            return { documentTargetGuard: true, documentProjectGuard: true };
          if (method === 'api.read')
            return {
              result:
                params?.path === 'DMT_Project.getCurrentProjectInfo'
                  ? { uuid: 'proj-1' }
                  : { uuid: 'pcb-1', parentProjectUuid: 'proj-1', documentType: 3 },
            };
          if (method === 'api.call')
            return {
              result: scenario === 'no-success' ? {} : { success: true },
              ...(scenario === 'missing'
                ? {}
                : {
                    targetDocument:
                      scenario === 'foreign'
                        ? { ...targetDocument, projectUuid: 'other' }
                        : targetDocument,
                  }),
            };
          return {};
        });
        const result = await registry.get('easyeda_pcb_autoroute')?.handler(context, {
          projectId: 'proj-1',
          confirmWrite: true,
          gateMode: 'warn',
          boardData: passingBoardData(),
        });
        expect(result).toMatchObject({ success: false, overall_verdict: 'failed' });
        expect(bridgeCall.mock.calls.filter(([method]) => method === 'api.call')).toHaveLength(1);
      },
    );

    it.each([3, 4, 5])(
      'withholds post-route checks when focus changes at read %i',
      async (switchRead) => {
        let reads = 0;
        bridgeCall.mockImplementation(async (method: string, params?: { path?: string }) => {
          if (method === 'system.getStatus')
            return { documentTargetGuard: true, documentProjectGuard: true };
          if (method === 'api.read')
            return {
              result:
                params?.path === 'DMT_Project.getCurrentProjectInfo'
                  ? { uuid: 'proj-1' }
                  : {
                      uuid: ++reads >= switchRead ? 'pcb-2' : 'pcb-1',
                      parentProjectUuid: 'proj-1',
                      documentType: 3,
                    },
            };
          if (method === 'api.call')
            return {
              result: { success: true },
              targetDocument: {
                uuid: 'pcb-1',
                projectUuid: 'proj-1',
                name: 'PCB',
                documentType: 'pcb',
              },
            };
          if (method === 'design.drc') return { passed: true };
          return {};
        });
        const result = await registry.get('easyeda_pcb_autoroute')?.handler(context, {
          projectId: 'proj-1',
          confirmWrite: true,
          gateMode: 'warn',
          boardData: passingBoardData(),
        });
        expect(result).toMatchObject({
          success: true,
          overall_verdict: 'partial',
          post_route_drc: undefined,
          post_route_constraint_report: undefined,
        });
        expect(bridgeCall.mock.calls.filter(([method]) => method === 'api.call')).toHaveLength(1);
      },
    );

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
      // The pre-flight reads board evidence from the bridge, but never reaches the autorouter.
      expect(bridgeCall.mock.calls.some(([method]) => method === 'api.call')).toBe(false);
    });

    it('names the unknown checks when it blocks a board with no errors (default gateMode block)', async () => {
      mockFocusedBridge(async () => ({}));
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        boardData: { hasOutline: true, layerCount: 2, hasLayerStack: true },
      })) as any;
      expect(result.overall_verdict).toBe('blocked');
      expect(result.preflight.error_count).toBe(0);
      expect(result.preflight.unknown_count).toBeGreaterThan(0);
      expect(result.preflight.gate_mode).toBe('block');
      expect(result.summary).toContain('unknown check(s)');
      expect(result.summary).toContain('gateMode');
      expect(bridgeCall.mock.calls.some(([method]) => method === 'api.call')).toBe(false);
    });

    it("routes with gateMode 'warn' when only unknown checks remain, and reports them", async () => {
      mockFocusedBridge(async (method: string) => {
        if (method === 'api.call') {
          return {
            result: { success: true, totalNetsCount: 3, successNetsCount: 3, failedNets: [] },
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
        return {};
      });
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        gateMode: 'warn',
        boardData: { hasOutline: true, layerCount: 2, hasLayerStack: true },
      })) as any;
      expect(result.blocked_by_preflight).toBe(false);
      expect(result.autoroute_result.started).toBe(true);
      expect(result.preflight.passed).toBe(true);
      expect(result.preflight.gate_mode).toBe('warn');
      expect(result.preflight.unknown_count).toBeGreaterThan(0);
      expect(result.preflight.unknown_checks.length).toBe(result.preflight.unknown_count);
    });

    it("still blocks on pre-flight errors with gateMode 'warn'", async () => {
      mockFocusedBridge(async () => ({}));
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        gateMode: 'warn',
        boardData: { hasOutline: false },
      })) as any;
      expect(result.overall_verdict).toBe('blocked');
      expect(result.preflight.error_count).toBeGreaterThan(0);
      expect(result.summary).toContain('Fix the errors');
      expect(bridgeCall.mock.calls.some(([method]) => method === 'api.call')).toBe(false);
    });

    it('merges caller boardData over the bridge evidence instead of replacing it', async () => {
      // The bridge measures the outline and holes; the caller supplies everything else.
      const measured = {
        widthMm: 60,
        heightMm: 40,
        hasOutline: true,
        mountingHoleCount: 4,
        minDrillMm: 0.3,
      };
      const callerPart = passingBoardData() as Record<string, unknown>;
      for (const key of Object.keys(measured)) delete callerPart[key];
      const routeOk = async (method: string) => {
        if (method === 'api.call') {
          return {
            result: { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [] },
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
        return {};
      };
      const tool = registry.get('easyeda_pcb_autoroute');

      mockFocusedBridge(async (method: string) =>
        method === 'board.getDimensions' ? measured : routeOk(method),
      );
      const merged = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        boardData: callerPart,
      })) as any;
      expect(merged.blocked_by_preflight).toBe(false);
      expect(merged.preflight.unknown_count).toBe(0);

      // Without the bridge measurements the same caller data leaves the outline and holes unknown.
      mockFocusedBridge(routeOk);
      const callerOnly = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        boardData: callerPart,
      })) as any;
      expect(callerOnly.blocked_by_preflight).toBe(true);
      expect(callerOnly.preflight.unknown_count).toBeGreaterThan(0);
    });

    it('waits longer than the default bridge timeout for the native autorouter', async () => {
      mockFocusedBridge(async (method: string) => {
        if (method === 'api.call') {
          return {
            result: { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [] },
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
        return {};
      });
      const tool = registry.get('easyeda_pcb_autoroute');
      await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        gateMode: 'warn',
        boardData: { hasOutline: true, layerCount: 2, hasLayerStack: true },
      });
      const autorouteCall = bridgeCall.mock.calls.find(([method]) => method === 'api.call');
      expect(autorouteCall?.[2]?.timeoutMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
      expect(autorouteCall?.[1]).toMatchObject({
        path: 'PCB_Document.autoRouting',
        expectedProjectUuid: 'proj-1',
        expectedPcbUuid: 'pcb-1',
      });
    });

    it('keeps known errors blocking: gateMode only accepts warn and block', () => {
      const tool = registry.get('easyeda_pcb_autoroute');
      expect(() =>
        tool?.inputSchema.parse({ projectId: 'p', confirmWrite: true, gateMode: 'off' }),
      ).toThrow();
    });

    it('blocks on unknown evidence when the bridge reads fail, without calling the autorouter', async () => {
      mockFocusedBridge(async (method: string) => {
        if (method.startsWith('board.')) throw new Error('bridge down');
        return {};
      });
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
      })) as any;
      expect(result.overall_verdict).toBe('blocked');
      expect(result.preflight.unknown_count).toBeGreaterThan(0);
      expect(bridgeCall.mock.calls.some(([method]) => method === 'api.call')).toBe(false);
    });

    it('refuses unavailable native context even with caller boardData', async () => {
      const throwingBridge = {
        get connected(): boolean {
          throw new Error('bridge state unavailable');
        },
        call: bridgeCall,
      };
      const tool = registry.get('easyeda_pcb_autoroute');
      for (const boardData of [undefined, passingBoardData()]) {
        const result = await tool?.handler(
          { ...context, bridge: throwingBridge } as unknown as ToolContext,
          { projectId: 'proj-1', confirmWrite: true, gateMode: 'warn', boardData },
        );
        expect(result).toMatchObject({ success: false, overall_verdict: 'blocked' });
      }
      expect(bridgeCall.mock.calls.some(([method]) => method === 'api.call')).toBe(false);
    });

    it('lets caller boardData override a bridge value', async () => {
      mockFocusedBridge(async (method: string) =>
        method === 'board.getDimensions' ? { hasOutline: true } : {},
      );
      const tool = registry.get('easyeda_pcb_autoroute');
      const result = (await tool?.handler(context, {
        projectId: 'proj-1',
        confirmWrite: true,
        gateMode: 'warn',
        boardData: { hasOutline: false },
      })) as any;
      expect(result.overall_verdict).toBe('blocked');
      expect(result.preflight.error_count).toBeGreaterThan(0);
    });

    it('reports failed (not silent success) when the autoroute bridge call throws', async () => {
      mockFocusedBridge(async (method: string) => {
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
      mockFocusedBridge(async (method: string) => {
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
      mockFocusedBridge(async (method: string) => {
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
