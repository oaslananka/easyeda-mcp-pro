import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import {
  buildEngineeringReview,
  engineeringReviewSchema,
} from '../../../src/engineering-review/report.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { registerEngineeringReviewTools } from '../../../src/tools/L1_engineering_review.js';
import type { ToolContext } from '../../../src/tools/types.js';

describe('evidence-based engineering review', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerEngineeringReviewTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'core',
      bridge: {
        connected: true,
        call: bridgeCall,
        easyedaVersion: '3.2.149',
        extensionVersion: '1.8.1',
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
        bridgeHost: '127.0.0.1',
        bridgePort: 49620,
      },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  async function run() {
    const tool = registry.get('easyeda_engineering_review');
    if (!tool) throw new Error('missing tool');
    return engineeringReviewSchema.parse(await tool.handler(context, { projectId: 'pcb-1' }));
  }

  it('exposes a strictly read-only tool with non-empty project identity', () => {
    const tool = registry.get('easyeda_engineering_review');
    expect(tool).toMatchObject({
      profile: 'core',
      confirmWrite: false,
      sideEffect: 'read-only',
      annotations: { readOnlyHint: true },
    });
    expect(() => tool?.inputSchema.parse({ projectId: '' })).toThrow();
  });

  it('aggregates measured PCB failures and deterministic evidence without claiming DRC or ERC', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return { widthMm: 60, heightMm: 40, hasOutline: false, mountingHoleCount: 0 };
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [{ id: 1 }] };
      if (method === 'board.getDesignRules') return { hasClearanceRules: true };
      if (method === 'board.listLayers') return [{ id: 1 }];
      throw new Error('unexpected bridge method');
    });

    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    expect(first.overall_status).toBe('FAIL');
    expect(first.pcb_context).toBe('observed');
    expect(first.source_version).toEqual({ easyeda: '3.2.149', extension: '1.8.1' });
    expect(first.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'FAIL', message: 'Board outline is not defined' }),
        expect.objectContaining({ id: 'coverage:DRC', status: 'UNKNOWN' }),
        expect.objectContaining({ id: 'coverage:ERC', status: 'UNKNOWN' }),
      ]),
    );
    expect(first.input_evidence).toContainEqual({
      field: 'widthMm',
      source: 'board.getDimensions',
      quality: 'measured',
      unit: 'mm',
      age: 'current_request',
      value: 60,
    });
    expect(first.runtime).toMatchObject({ bridge_connected: true });
    expect(first.groups.blocking).toContain(
      first.findings.find((f) => f.rule_id === 'PCB_MISSING_OUTLINE')?.id,
    );
    expect(first.groups.unknowns).toContain('coverage:DRC');
    expect(first.groups.passed).not.toContain('coverage:DRC');
    expect(first.engineering_sign_off).toBe(false);
    expect(first.human_review_required.length).toBeGreaterThan(0);
    expect(bridgeCall).toHaveBeenCalledTimes(8);
    expect([...new Set(bridgeCall.mock.calls.map(([method]) => method))].sort()).toEqual([
      'board.getDesignRules',
      'board.getDimensions',
      'board.getStackup',
      'board.listLayers',
    ]);
  });

  it('treats a wrong-tab or unsupported native response as unknown, never a pass', async () => {
    bridgeCall.mockRejectedValue(new Error('wrong document type'));
    const result = await run();

    expect(result.pcb_context).toBe('unverified');
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.summary.PASS).toBe(0);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'context:PCB_NOT_OBSERVED', status: 'UNKNOWN' }),
      ]),
    );
    expect(result.observations.every((observation) => observation.status === 'unavailable')).toBe(
      true,
    );
    expect(result.input_evidence.every((evidence) => evidence.quality === 'unavailable')).toBe(
      true,
    );
  });

  it('never attributes measurements from a different focused project to the requested review', async () => {
    bridgeCall.mockRejectedValue(
      new Error('PCB project identity mismatch: requested project UUID must match the focused PCB'),
    );
    const result = await run();

    expect(result.project_id).toBe('pcb-1');
    expect(result.pcb_context).toBe('unverified');
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.summary).toMatchObject({ PASS: 0, FAIL: 0 });
    expect(result.input_evidence.every((entry) => entry.quality !== 'measured')).toBe(true);
    expect(result.observations.every((entry) => entry.status === 'unavailable')).toBe(true);
    expect(result.engineering_sign_off).toBe(false);
  });

  it('skips every native read when bridge is disconnected', async () => {
    context.bridge.connected = false;
    const result = await run();
    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.observations).toHaveLength(4);
    expect(result.observations.every((item) => item.status === 'unavailable')).toBe(true);
  });

  it('downgrades native observations when the extension identity differs from the server', async () => {
    context.bridge.registryMismatch = true;
    context.bridge.extensionVersionMismatch = true;
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') {
        return { widthMm: 60, heightMm: 40, hasOutline: true };
      }
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [{ id: 1 }] };
      if (method === 'board.getDesignRules') return { hasClearanceRules: true };
      throw new Error('unexpected bridge method');
    });

    const report = await run();
    expect(report.runtime).toMatchObject({
      bridge_connected: true,
      registry_mismatch: true,
      extension_version_mismatch: true,
    });
    expect(report.pcb_context).toBe('unverified');
    expect(report.overall_status).toBe('UNKNOWN');
    expect(report.groups.unknowns).toContain('context:SOURCE_VERSION_MISMATCH');
    expect(report.groups.passed).not.toContain('pcb:OBSERVED_CONSTRAINT_SUBSET');
    expect(report.input_evidence.find((entry) => entry.field === 'widthMm')).toMatchObject({
      source: 'board.getDimensions',
      quality: 'unverified',
      age: 'unverified',
    });
    expect(bridgeCall.mock.calls.map(([method]) => method)).not.toContain('design.drc');
    expect(bridgeCall.mock.calls.map(([method]) => method)).not.toContain('design.erc');
  });

  it.each(['easyedaVersion', 'extensionVersion'] as const)(
    'rejects native evidence when %s changes during a single review',
    async (field) => {
      bridgeCall.mockImplementation(async (method: string) => {
        if (method === 'board.getDimensions') {
          context.bridge[field] = 'changed-during-read';
          return { widthMm: 60, heightMm: 40, hasOutline: false };
        }
        if (method === 'board.listLayers') return [];
        if (method === 'board.getStackup') return { totalLayers: 2, layers: [{ id: 1 }] };
        if (method === 'board.getDesignRules') return { hasClearanceRules: true };
        throw new Error('unexpected bridge method');
      });
      const result = await run();
      expect(result.pcb_context).toBe('unverified');
      expect(result.overall_status).toBe('UNKNOWN');
      expect(result.summary.FAIL).toBe(0);
      expect(result.groups.unknowns).toContain('context:SOURCE_CHANGED_DURING_READ');
      expect(result.groups.passed).not.toContain('pcb:OBSERVED_CONSTRAINT_SUBSET');
      expect(result.input_evidence.find((e) => e.field === 'widthMm')).toMatchObject({
        quality: 'unverified',
        age: 'unverified',
      });
    },
  );

  it('does not turn a partial native response into successful verification', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') return { widthMm: 60, heightMm: 40 };
      if (method === 'board.listLayers') return [];
      throw new Error('capability not supported');
    });
    const result = await run();
    expect(result.pcb_context).toBe('observed');
    expect(result.summary.UNKNOWN).toBeGreaterThan(0);
    expect(result.overall_status).not.toBe('PASS');
    expect(result.input_evidence.find((e) => e.field === 'hasClearanceRules')).toMatchObject({
      quality: 'unavailable',
      age: 'unverified',
    });
    expect(result.findings.some((f) => f.status === 'UNKNOWN')).toBe(true);
  });

  it('rejects malformed measurements instead of converting negative numbers into passes', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') return { widthMm: -5, heightMm: 'invalid' };
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return {};
      if (method === 'board.getDesignRules') return {};
      throw new Error('unexpected');
    });
    const result = await run();
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.pcb_context).toBe('unverified');
    expect(result.input_evidence.find((e) => e.field === 'widthMm')).toMatchObject({
      quality: 'unavailable',
    });
  });

  it('exposes stable rule identifiers and scoped positive evidence', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') return { widthMm: 60, heightMm: 40, hasOutline: false };
      if (method === 'board.getStackup') return { totalLayers: 2, layers: [{ id: 1 }] };
      if (method === 'board.getDesignRules') return { hasClearanceRules: true };
      return [];
    });
    const result = await run();
    const outline = result.findings.find((finding) => finding.rule_id === 'PCB_MISSING_OUTLINE');
    expect(outline).toMatchObject({
      status: 'FAIL',
      rule_revision: '1.0.0',
      requirement_source: 'easyeda-mcp-pro/pcb-constraints',
      confidence: 'derived',
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ id: 'pcb:OBSERVED_CONSTRAINT_SUBSET', status: 'PASS' }),
    );
    expect(result.overall_status).not.toBe('PASS');
  });

  it('distinguishes not-applicable conditions from unknown inputs', () => {
    const report = buildEngineeringReview({
      projectId: 'pcb-2',
      bridgeConnected: false,
      observations: [],
      evidenceMode: 'supplied',
      boardData: {
        hasHighVoltage: false,
        requiresProgrammingHeader: false,
        polarizedComponentCount: 0,
        smtComponentCount: 0,
        criticalNetNames: [],
      },
    });
    engineeringReviewSchema.parse(report);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ id: 'pcb:NOT_APPLICABLE_COUNT', status: 'NOT_APPLICABLE' }),
    );
    expect(report.summary.NOT_APPLICABLE).toBeGreaterThan(0);
    expect(report.summary.UNKNOWN).toBeGreaterThan(0);
    expect(report.input_evidence.every((entry) => entry.quality !== 'measured')).toBe(true);
    expect(report.engineering_sign_off).toBe(false);
  });

  it('drops prior-tab measurements after a subsequent native read becomes unavailable', async () => {
    let wrongTab = false;
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions') {
        if (wrongTab) throw new Error('active document is not a PCB');
        return { widthMm: 1, heightMm: 1, hasOutline: false };
      }
      if (method === 'board.listLayers') return [];
      if (method === 'board.getStackup') return {};
      if (method === 'board.getDesignRules') return {};
      throw new Error('unexpected bridge method');
    });

    const original = await run();
    expect(original.overall_status).toBe('FAIL');
    expect(original.findings.some((f) => f.rule_id === 'PCB_MISSING_OUTLINE')).toBe(true);

    wrongTab = true;
    const afterTabSwitch = await run();
    expect(afterTabSwitch.pcb_context).toBe('unverified');
    expect(afterTabSwitch.overall_status).toBe('UNKNOWN');
    expect(afterTabSwitch.summary.PASS).toBe(0);
    expect(afterTabSwitch.summary.FAIL).toBe(0);
    expect(afterTabSwitch.findings.some((f) => f.rule_id === 'PCB_MISSING_OUTLINE')).toBe(false);
    expect(afterTabSwitch.input_evidence.find((e) => e.field === 'widthMm')).toMatchObject({
      quality: 'unavailable',
      age: 'unverified',
    });
    expect(bridgeCall).toHaveBeenCalledTimes(8);
    expect(new Set(bridgeCall.mock.calls.map(([method]) => method))).toEqual(
      new Set([
        'board.getDimensions',
        'board.listLayers',
        'board.getStackup',
        'board.getDesignRules',
      ]),
    );
  });

  it('does not treat fulfilled empty wrong-tab replies as successful PCB measurements', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.listLayers') return [];
      return {};
    });
    const result = await run();
    expect(result.observations.every((o) => o.status === 'observed')).toBe(true);
    expect(result.pcb_context).toBe('unverified');
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.summary.PASS).toBe(0);
    expect(result.engineering_sign_off).toBe(false);
    expect(result.groups.unknowns).toContain('context:PCB_NOT_OBSERVED');
  });

  it('downgrades a previously observed failing board when the bridge disconnects', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return {
          widthMm: 1,
          heightMm: 1,
          hasOutline: false,
        };
      return {};
    });
    expect((await run()).overall_status).toBe('FAIL');
    const count = bridgeCall.mock.calls.length;
    context.bridge.connected = false;
    const afterDisconnect = await run();
    expect(bridgeCall).toHaveBeenCalledTimes(count);
    expect(afterDisconnect.overall_status).toBe('UNKNOWN');
    expect(afterDisconnect.pcb_context).toBe('unverified');
    expect(afterDisconnect.summary.FAIL).toBe(0);
    expect(afterDisconnect.input_evidence.every((e) => e.quality === 'unavailable')).toBe(true);
  });

  it('uses no native design mutation, DRC/ERC execution, export or project save', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'board.getDimensions')
        return {
          widthMm: 65,
          heightMm: 35,
          hasOutline: true,
        };
      if (method === 'board.getStackup')
        return {
          totalLayers: 2,
          layers: [{ id: 1 }, { id: 2 }],
        };
      if (method === 'board.getDesignRules')
        return {
          hasClearanceRules: true,
        };
      if (method === 'board.listLayers') return [{ id: 1 }, { id: 2 }];
      throw new Error('undeclared bridge operation');
    });
    const result = await run();
    expect(result.engineering_sign_off).toBe(false);
    expect(result.groups.unknowns).toContain('coverage:DRC');
    expect(result.groups.unknowns).toContain('coverage:ERC');
    expect(result.groups.unknowns).toContain('coverage:POWER_TREE');
    expect(new Set(bridgeCall.mock.calls.map(([method]) => method))).toEqual(
      new Set([
        'board.getDimensions',
        'board.listLayers',
        'board.getStackup',
        'board.getDesignRules',
      ]),
    );
    expect(bridgeCall.mock.calls.every(([method]) => method.startsWith('board.'))).toBe(true);
  });
});
