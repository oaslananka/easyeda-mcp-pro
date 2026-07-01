import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerDrcErcTools } from '../../../src/tools/L1_drc_erc.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('Power tree tool', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerDrcErcTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'core',
      bridge: { connected: true, call: bridgeCall },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
        bridgeHost: '127.0.0.1',
        bridgePort: 49620,
      },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  it('reports failing current and regulator conditions', async () => {
    const tool = registry.get('easyeda_power_tree_analyze');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      projectId: 'power-tool-1',
      rails: [
        { id: 'vin', name: 'VIN', voltage: 3.6, external: true, requiresProtection: true },
        { id: '3v3', name: '3V3', voltage: 3.3, maxCurrentA: 0.6 },
      ],
      sources: [
        {
          id: 'src1',
          kind: 'usb',
          railId: 'vin',
          voltage: 3.6,
          maxCurrentA: 1,
          requiresProtection: true,
        },
      ],
      regulators: [
        {
          id: 'ldo1',
          ref: 'U1',
          kind: 'ldo',
          inputRailId: 'vin',
          outputRailId: '3v3',
          maxOutputCurrentA: 0.5,
          dropoutVoltage: 0.5,
          thermalResistanceCPerW: 150,
          maxJunctionTempC: 85,
        },
      ],
      loads: [{ id: 'load', ref: 'U2', railId: '3v3', currentA: 0.7, peakCurrentA: 0.7 }],
      limits: { ambientTempC: 60 },
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.project_id).toBe('power-tool-1');
    expect(result?.passed).toBe(false);
    expect(result?.summary.humanSummary).toContain('Power tree failed');
    expect(result?.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        'POWER_RAIL_OVERCURRENT',
        'POWER_SOURCE_MISSING_PROTECTION',
        'POWER_REGULATOR_OVERLOAD',
        'POWER_REGULATOR_DROPOUT',
        'POWER_REGULATOR_THERMAL_OVER_LIMIT',
      ]),
    );
  });
});
