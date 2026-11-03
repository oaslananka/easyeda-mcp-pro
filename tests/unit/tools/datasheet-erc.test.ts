import { describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { registerDrcErcTools } from '../../../src/tools/L1_drc_erc.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';

const source = {
  partNumber: 'EXAMPLE-U1',
  package: 'QFN-32',
  revision: 'rev-A',
  source: 'Hypothetical device datasheet; not independently verified',
  section: 'Electrical characteristics',
};
const nets = [
  {
    id: 'five',
    name: '5V',
    type: 'power' as const,
    voltage: 5,
    nodes: [
      { deviceRef: 'U1', pin: 'VDD' },
      { deviceRef: 'U1', pin: 'IO' },
    ],
  },
  {
    id: 'ground',
    name: 'GND',
    type: 'ground' as const,
    voltage: 0,
    nodes: [{ deviceRef: 'U1', pin: 'GND' }],
  },
  {
    id: 'nominal',
    name: '3V3_NOMINAL',
    type: 'power' as const,
    nodes: [{ deviceRef: 'U1', pin: 'VREF' }],
  },
];
const devices = [
  {
    id: 'U1',
    ref: 'U1',
    pins: [
      { pin: 'VDD', electricalType: 'power_input' as const },
      { pin: 'IO', electricalType: 'input' as const },
      { pin: 'GND', electricalType: 'power_input' as const },
      { pin: 'NC', electricalType: 'no_connect' as const, noConnectAllowed: true },
      { pin: 'VREF', electricalType: 'power_input' as const },
    ],
  },
];

function toolSetup() {
  const registry = new ToolRegistry();
  registerDrcErcTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  const tool = registry.get('easyeda_semantic_erc_validate');
  if (!tool) throw Error('missing semantic ERC');
  const call = vi.fn();
  const context = {
    profile: 'core',
    bridge: { connected: false, call },
    config: {
      bridgeTimeoutMs: 1000,
      artifactDir: '.easyeda-mcp-pro/artifacts',
      bridgeHost: '127.0.0.1',
      bridgePort: 49620,
    },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as ToolContext;
  return { tool, context, call };
}

describe('optional source-aware electrical review MCP contract', () => {
  it('extends existing semantic ERC without another tool or bridge mutation', async () => {
    const { tool, context, call } = toolSetup();
    expect(tool).toMatchObject({
      name: 'easyeda_semantic_erc_validate',
      confirmWrite: false,
      annotations: { readOnlyHint: true },
    });
    const result = await tool.handler(context, {
      projectId: 'p',
      nets,
      devices,
      datasheetConstraints: [
        { kind: 'pin_voltage', componentRef: 'U1', pin: 'IO', maxVoltageV: 3.6, reference: source },
        { kind: 'intentional_nc', componentRef: 'U1', pin: 'NC', reference: source },
      ],
    });
    expect(call).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      project_id: 'p',
      passed: false,
      electrical_approval: false,
      datasheet_review: {
        status: 'WARNING',
        source_authenticity: 'CALLER_DECLARED_UNVERIFIED',
        engineering_sign_off: false,
        finding_count: 2,
      },
    });
    expect(result.datasheet_review.findings[0]).toMatchObject({
      status: 'WARNING',
      component_ref: 'U1',
      pins: ['IO'],
      nets: ['5V'],
      observed_voltages_v: [{ net: '5V', voltage_v: 5 }],
    });
    expect(result.datasheet_review.findings[1]).toMatchObject({
      status: 'UNKNOWN',
      component_ref: 'U1',
      pins: ['NC'],
      nets: [],
    });
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('keeps undeclared/in-range datasheet compliance unapproved', async () => {
    const { tool, context } = toolSetup();
    const result = await tool.handler(context, {
      nets,
      devices,
      datasheetConstraints: [
        {
          kind: 'pin_voltage',
          componentRef: 'U1',
          pin: 'VREF',
          maxVoltageV: 3.3,
          reference: source,
        },
      ],
    });
    expect(result.datasheet_review.status).toBe('UNKNOWN');
    expect(result.datasheet_review.findings[0].observed_voltages_v).toEqual([]);
    expect(result.electrical_approval).toBe(false);
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('rejects absent exact part identity, invalid limits, same regulator pins and unbounded batches', () => {
    const { tool } = toolSetup();
    const valid = {
      kind: 'pin_voltage',
      componentRef: 'U1',
      pin: 'IO',
      maxVoltageV: 3.6,
      reference: source,
    };
    const bad = [
      { ...valid, reference: { ...source, package: '' } },
      { ...valid, reference: { ...source, revision: '' } },
      { ...valid, maxVoltageV: Infinity },
      { ...valid, minVoltageV: 5, maxVoltageV: 3.3 },
      { ...valid, componentRef: ' U1 ' },
      {
        kind: 'regulator_headroom',
        componentRef: 'U1',
        inputPin: 'IO',
        outputPin: 'IO',
        minHeadroomV: 1,
        reference: source,
      },
    ];
    for (const constraint of bad) {
      expect(
        tool.inputSchema.safeParse({ nets, devices, datasheetConstraints: [constraint] }).success,
      ).toBe(false);
    }
    expect(tool.inputSchema.safeParse({ nets, devices, datasheetConstraints: [] }).success).toBe(
      false,
    );
    expect(
      tool.inputSchema.safeParse({
        nets,
        devices,
        datasheetConstraints: Array.from({ length: 25 }, () => valid),
      }).success,
    ).toBe(false);
  });

  it('preserves previously supported shape for invocations without datasheet constraints', async () => {
    const { tool, context } = toolSetup();
    const result = await tool.handler(context, { nets, devices });
    expect(result.datasheet_review).toBeUndefined();
    expect(result.electrical_approval).toBeUndefined();
    expect(tool.outputSchema.parse(result)).toEqual(result);
  });

  it('flags explicitly unexpected supply mapping without inventing a measured voltage', async () => {
    const { tool, context } = toolSetup();
    const result = await tool.handler(context, {
      nets,
      devices,
      datasheetConstraints: [
        {
          kind: 'pin_voltage',
          componentRef: 'U1',
          pin: 'VREF',
          expectedNet: '3V3',
          reference: source,
        },
      ],
    });
    expect(result.datasheet_review.findings[0]).toMatchObject({
      status: 'WARNING',
      nets: ['3V3_NOMINAL'],
      observed_voltages_v: [],
    });
    expect(result.electrical_approval).toBe(false);
  });
});
