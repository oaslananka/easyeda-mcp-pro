import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerExportTools } from '../../../src/tools/L1_export.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('Production QA tool', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerExportTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'pro',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  it('returns handoff artifacts without bridge calls', async () => {
    const tool = registry.get('easyeda_production_qa_artifacts');
    expect(tool).toBeDefined();

    const result = await tool?.handler(context, {
      projectId: 'proj-qa',
      projectName: 'Sensor Board',
      criticalNets: [
        { name: 'GND', category: 'ground', hasTestPoint: true, testPointRef: 'TP1' },
        { name: '3V3', category: 'power', hasTestPoint: false },
      ],
      components: [{ ref: 'D1', value: 'LED', polarized: true, orientationMark: false }],
      requiresProgramming: true,
      programmingInterfaces: ['SWD'],
      hasProgrammingAccess: false,
    });

    expect(bridgeCall).not.toHaveBeenCalled();
    expect(result?.project_id).toBe('proj-qa');
    expect(result?.passed).toBe(false);
    expect(result?.summary.missingTestpointCount).toBe(1);
    expect(result?.artifacts).toHaveLength(5);
  });
});
