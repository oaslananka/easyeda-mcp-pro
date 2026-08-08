import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createValidationNetArtifacts,
  discoverActiveDocument,
  placeValidationComponents,
  searchValidationDevices,
  selectValidationDevicePair,
  verifyRequiredBridgeMethods,
  waitForLiveBridge,
} from '../../../scripts/e2e/live-phases.mjs';

function createReporter() {
  return {
    ok: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
    capture: vi.fn(),
  };
}

describe('live E2E bounded phases', () => {
  it('uses the shared stdio harness instead of hand-rolled process/RPC lifecycle code', () => {
    const livePath = fileURLToPath(new URL('../../../scripts/e2e/live.mjs', import.meta.url));
    const source = readFileSync(livePath, 'utf8');

    expect(source).toContain('startStdioMcpServer');
    expect(source).not.toContain('spawnTrackedProcess');
    expect(source).not.toContain("from 'node:readline'");
    expect(source).not.toContain('const pending = new Map()');
  });

  it('returns the connected bridge status without sleeping', async () => {
    const reporter = createReporter();
    const toolCall = vi.fn(async () => ({
      text: JSON.stringify({ connected: true, bridge_version: '9.1.0', capabilities: ['x'] }),
    }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForLiveBridge({ toolCall, maxWaitSeconds: 120, sleep, log: vi.fn(), reporter }),
    ).resolves.toEqual({
      connected: true,
      status: { connected: true, bridge_version: '9.1.0', capabilities: ['x'] },
    });
    expect(toolCall).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(reporter.ok).toHaveBeenCalledWith('Bridge connected', 'version=9.1.0');
    expect(reporter.capture).toHaveBeenCalledWith(
      'bridge status',
      expect.objectContaining({ connected: true }),
    );
  });

  it('bounds bridge retries and logs every 15 seconds', async () => {
    const toolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: 'not-json' })
      .mockResolvedValue({ text: JSON.stringify({ connected: false }) });
    const sleep = vi.fn(async () => undefined);
    const log = vi.fn();

    await expect(
      waitForLiveBridge({
        toolCall,
        maxWaitSeconds: 18,
        sleep,
        log,
        reporter: createReporter(),
      }),
    ).resolves.toEqual({ connected: false, status: { connected: false } });
    expect(toolCall).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(log).toHaveBeenCalledWith('  ⏳ waiting for bridge... 15s elapsed');
  });

  it('verifies required methods from capabilities and inventory fallback', async () => {
    const reporter = createReporter();
    const toolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: 'inventory includes schematic.createNetPort' })
      .mockResolvedValueOnce({ text: 'nothing useful' });

    await expect(
      verifyRequiredBridgeMethods({
        toolCall,
        capabilities: ['schematic.createNetFlag'],
        requiredMethods: [
          'schematic.createNetFlag',
          'schematic.createNetPort',
          'schematic.validateNetlist',
        ],
        reporter,
      }),
    ).resolves.toEqual({
      'schematic.createNetFlag': true,
      'schematic.createNetPort': true,
      'schematic.validateNetlist': false,
    });
    expect(toolCall).toHaveBeenCalledTimes(2);
    expect(reporter.ok).toHaveBeenCalledTimes(2);
    expect(reporter.fail).toHaveBeenCalledWith(
      'Bridge method: schematic.validateNetlist',
      'not in capabilities',
    );
  });

  it('treats an inventory error as a missing required method', async () => {
    const reporter = createReporter();
    const toolCall = vi.fn(async () => {
      throw new Error('inventory unavailable');
    });

    await expect(
      verifyRequiredBridgeMethods({
        toolCall,
        capabilities: [],
        requiredMethods: ['project.save'],
        reporter,
      }),
    ).resolves.toEqual({ 'project.save': false });
    expect(reporter.fail).toHaveBeenCalledWith(
      'Bridge method: project.save',
      'not in capabilities',
    );
  });

  it('discovers an active document from nets and captures initial net evidence', async () => {
    const reporter = createReporter();
    const toolCall = vi.fn(async () => ({
      text: JSON.stringify({ nets: [{ netName: 'GND' }] }),
    }));

    await expect(discoverActiveDocument({ toolCall, projectId: 'active', reporter })).resolves.toBe(
      true,
    );
    expect(toolCall).toHaveBeenCalledTimes(1);
    expect(reporter.ok).toHaveBeenCalledWith('Active document confirmed', '1 initial nets');
    expect(reporter.capture).toHaveBeenCalledWith('initial nets', expect.any(String));
  });

  it('falls back to components when net discovery is unavailable', async () => {
    const reporter = createReporter();
    const toolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ not_available: true }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ components: [] }) });

    await expect(discoverActiveDocument({ toolCall, projectId: 'active', reporter })).resolves.toBe(
      true,
    );
    expect(toolCall).toHaveBeenNthCalledWith(2, 'easyeda_schematic_components', {
      projectId: 'active',
      limit: 1,
    });
    expect(reporter.ok).toHaveBeenCalledWith('Active document confirmed via components');
  });

  it('returns false when both active-document probes fail', async () => {
    const toolCall = vi.fn(async () => {
      throw new Error('no active document');
    });

    await expect(
      discoverActiveDocument({ toolCall, projectId: 'active', reporter: createReporter() }),
    ).resolves.toBe(false);
    expect(toolCall).toHaveBeenCalledTimes(2);
  });

  it('searches live device keywords in order and warns on recoverable errors', async () => {
    const reporter = createReporter();
    const first = { uuid: 'one' };
    const second = { uuid: 'two' };
    const toolCall = vi
      .fn()
      .mockRejectedValueOnce(new Error('search unavailable'))
      .mockResolvedValueOnce({ text: JSON.stringify({ devices: [first] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ results: [first, second] }) });

    await expect(searchValidationDevices({ toolCall, reporter })).resolves.toEqual([first, second]);
    expect(toolCall).toHaveBeenNthCalledWith(1, 'easyeda_schematic_search_device', {
      key: 'resistor',
      itemsOfPage: 10,
      page: 1,
    });
    expect(toolCall).toHaveBeenNthCalledWith(3, 'easyeda_schematic_search_device', {
      key: 'R_0805',
      itemsOfPage: 10,
      page: 1,
    });
    expect(reporter.warn).toHaveBeenCalledWith(
      'Device search attempt',
      'resistor: search unavailable',
    );
  });

  it('prefers 0603 and 0805 devices and normalizes device identifiers', () => {
    const devices = [
      { title: 'Generic', uuid: 'g', libraryUuid: 'lg' },
      { title: 'R_0805', deviceUUID: 'u8', libraryId: 'l8' },
      { title: 'R_0603', mp: 'u6', libraryUuid: 'l6' },
    ];

    expect(selectValidationDevicePair(devices)).toEqual({
      dev0: devices[2],
      dev1: devices[1],
      d0Uuid: 'u6',
      d0LibraryUuid: 'l6',
      d1Uuid: 'u8',
      d1LibraryUuid: 'l8',
      dev0Name: 'R_0603',
      dev1Name: 'R_0805',
    });
  });

  it('keeps two distinct fallback devices when preferred names are absent', () => {
    const devices = [
      { name: 'A', uuid: 'a' },
      { display: 'B', uuid: 'b' },
    ];
    const selected = selectValidationDevicePair(devices);
    expect(selected.dev0).toBe(devices[0]);
    expect(selected.dev1).toBe(devices[1]);
    expect(selected.dev0Name).toBe('A');
    expect(selected.dev1Name).toBe('B');
  });

  it('places components, reads pins, and verifies native no-connect set/readback/clear', async () => {
    const reporter = createReporter();
    const responses = [
      { text: JSON.stringify({ component: { primitiveId: 'r1-id' } }) },
      { text: JSON.stringify({ component: { primitiveId: 'r2-id' } }) },
      { text: JSON.stringify({ pins: [{ pinNumber: '1' }, { pinNumber: '2' }] }) },
      { text: JSON.stringify({ pins: [{ pinNumber: '1', primitiveId: 'pin-1' }] }) },
      { text: JSON.stringify({ no_connected: true, verified: true }) },
      {
        text: JSON.stringify({
          pins: [{ pinNumber: '1', primitiveId: 'pin-1', noConnected: true }],
        }),
      },
      { text: JSON.stringify({ no_connected: false, verified: true }) },
    ];
    const toolCall = vi.fn(async () => responses.shift()!);

    await expect(
      placeValidationComponents({
        toolCall,
        projectId: 'active',
        devices: {
          d0Uuid: 'u0',
          d0LibraryUuid: 'l0',
          d1Uuid: 'u1',
          d1LibraryUuid: 'l1',
        },
        reporter,
      }),
    ).resolves.toEqual({
      r1PrimId: 'r1-id',
      r2PrimId: 'r2-id',
      r2Pins: [{ pinNumber: '1', primitiveId: 'pin-1' }],
      r1Ref: 'E2E_R1',
      r2Ref: 'E2E_R2',
    });
    expect(toolCall).toHaveBeenCalledWith(
      'easyeda_schematic_set_pin_no_connect',
      expect.objectContaining({ primitiveId: 'r2-id', pinNumber: '1', noConnected: true }),
    );
    expect(toolCall).toHaveBeenCalledWith(
      'easyeda_schematic_set_pin_no_connect',
      expect.objectContaining({ primitiveId: 'r2-id', pinNumber: '1', noConnected: false }),
    );
    expect(reporter.fail).not.toHaveBeenCalled();
  });

  it('recovers primitive IDs from component enumeration when placement responses omit them', async () => {
    const reporter = createReporter();
    const responses = [
      { text: '{}' },
      { text: '{}' },
      {
        text: JSON.stringify({
          components: [
            { reference: 'R1', primitiveId: 'enum-1' },
            { reference: 'R2', primitiveId: 'enum-2' },
          ],
        }),
      },
      { text: JSON.stringify({ pins: [] }) },
      { text: JSON.stringify({ pins: [] }) },
    ];
    const toolCall = vi.fn(async () => responses.shift()!);

    const result = await placeValidationComponents({
      toolCall,
      projectId: 'active',
      devices: { d0Uuid: 'u0', d0LibraryUuid: '', d1Uuid: 'u1', d1LibraryUuid: '' },
      reporter,
    });

    expect(result.r1PrimId).toBe('enum-1');
    expect(result.r2PrimId).toBe('enum-2');
    expect(reporter.warn).toHaveBeenCalledWith(
      'Native No Connect',
      'Skipped because no addressable R2 pin was available',
    );
  });

  it('covers bridge version fallbacks and the default logger adapter', async () => {
    const reporter = createReporter();
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForLiveBridge({
        toolCall: vi.fn(async () => ({
          text: JSON.stringify({ connected: true, version: '2.0' }),
        })),
        maxWaitSeconds: 3,
        sleep,
        reporter,
      }),
    ).resolves.toMatchObject({ connected: true });
    expect(reporter.ok).toHaveBeenCalledWith('Bridge connected', 'version=2.0');

    const unknownReporter = createReporter();
    await waitForLiveBridge({
      toolCall: vi.fn(async () => ({ text: JSON.stringify({ connected: true }) })),
      maxWaitSeconds: 3,
      sleep,
      reporter: unknownReporter,
    });
    expect(unknownReporter.ok).toHaveBeenCalledWith('Bridge connected', 'version=?');
  });

  it('uses the default required-method set without inventory calls when capabilities are complete', async () => {
    const reporter = createReporter();
    const toolCall = vi.fn();
    const capabilities = [
      'schematic.createNetFlag',
      'schematic.createNetPort',
      'schematic.connectPinToNet',
      'schematic.connectPinsByNet',
      'schematic.validateNetlist',
      'project.save',
    ];

    const result = await verifyRequiredBridgeMethods({ toolCall, capabilities, reporter });

    expect(Object.keys(result)).toEqual(capabilities);
    expect(Object.values(result)).toEqual(capabilities.map(() => true));
    expect(toolCall).not.toHaveBeenCalled();
  });

  it('handles empty active-document payloads and a null component fallback', async () => {
    const emptyReporter = createReporter();
    await expect(
      discoverActiveDocument({
        toolCall: vi.fn(async () => ({ text: '{}' })),
        projectId: 'active',
        reporter: emptyReporter,
      }),
    ).resolves.toBe(true);
    expect(emptyReporter.ok).toHaveBeenCalledWith('Active document confirmed', '0 initial nets');

    const fallbackToolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ not_available: true }) })
      .mockResolvedValueOnce({ text: 'null' });
    await expect(
      discoverActiveDocument({
        toolCall: fallbackToolCall,
        projectId: 'active',
        reporter: createReporter(),
      }),
    ).resolves.toBe(false);
  });

  it('returns an empty device set after exhausting empty default-keyword responses', async () => {
    const toolCall = vi.fn(async () => ({ text: '{}' }));

    await expect(
      searchValidationDevices({ toolCall, reporter: createReporter() }),
    ).resolves.toEqual([]);
    expect(toolCall).toHaveBeenCalledTimes(4);
  });

  it('normalizes a single sparse device through empty identifier fallbacks', () => {
    const device = { display: 'Display only' };

    expect(selectValidationDevicePair([device])).toEqual({
      dev0: device,
      dev1: device,
      d0Uuid: '',
      d0LibraryUuid: '',
      d1Uuid: '',
      d1LibraryUuid: '',
      dev0Name: 'Display only',
      dev1Name: 'Display only',
    });
  });

  it('tolerates placement and pin-read errors while recovering IDs from results aliases', async () => {
    const reporter = createReporter();
    let placeCount = 0;
    let pinCount = 0;
    const toolCall = vi.fn(async (name: string) => {
      if (name === 'easyeda_schematic_place_component') {
        placeCount += 1;
        if (placeCount === 1) throw new Error('place failed');
        return { text: 'not-json' };
      }
      if (name === 'easyeda_schematic_components') {
        return {
          text: JSON.stringify({
            results: [
              { ref: 'R_A', uuid: 'enum-a' },
              { name: 'E2E_B', id: 'enum-b' },
              { reference: 'IGNORED', primitiveId: 'ignore-me' },
            ],
          }),
        };
      }
      if (name === 'easyeda_schematic_component_pins') {
        pinCount += 1;
        if (pinCount === 1) throw new Error('pins unavailable');
        return { text: JSON.stringify({ pins: [{ number: '7' }] }) };
      }
      if (name === 'easyeda_schematic_set_pin_no_connect') {
        return { text: JSON.stringify({ no_connected: false, verified: true }) };
      }
      throw new Error(`unexpected tool ${name}`);
    });

    const result = await placeValidationComponents({
      toolCall,
      projectId: 'active',
      devices: { d0Uuid: 'u0', d0LibraryUuid: '', d1Uuid: 'u1', d1LibraryUuid: '' },
      reporter,
    });

    expect(result.r1PrimId).toBe('enum-a');
    expect(result.r2PrimId).toBe('enum-b');
    expect(reporter.fail).toHaveBeenCalledWith('Place R1', 'place failed');
    expect(reporter.warn).toHaveBeenCalledWith('R1 pins', 'pins unavailable');
    expect(reporter.fail).toHaveBeenCalledWith(
      'Native No Connect set/readback/clear',
      expect.stringContaining('set readback was not verified'),
    );
  });

  it('falls back to synthetic component refs when placement and enumeration both fail', async () => {
    const reporter = createReporter();
    const toolCall = vi.fn(async (name: string) => {
      if (name === 'easyeda_schematic_place_component') return { text: '{}' };
      if (name === 'easyeda_schematic_components') throw new Error('enumeration unavailable');
      if (name === 'easyeda_schematic_component_pins')
        return { text: JSON.stringify({ pins: [] }) };
      throw new Error(`unexpected tool ${name}`);
    });

    const result = await placeValidationComponents({
      toolCall,
      projectId: 'active',
      devices: { d0Uuid: 'u0', d0LibraryUuid: '', d1Uuid: 'u1', d1LibraryUuid: '' },
      reporter,
    });

    expect(result.r1PrimId).toBe('E2E_R1');
    expect(result.r2PrimId).toBe('E2E_R2');
    expect(reporter.warn).toHaveBeenCalledWith('Component enumeration', 'enumeration unavailable');
  });

  it('reports a native no-connect readback mismatch', async () => {
    const reporter = createReporter();
    const responses = [
      { text: JSON.stringify({ component: { primitiveId: 'r1' } }) },
      { text: JSON.stringify({ component: { primitiveId: 'r2' } }) },
      { text: JSON.stringify({ pins: [] }) },
      { text: JSON.stringify({ pins: [{ number: '9' }] }) },
      { text: JSON.stringify({ no_connected: true, verified: true }) },
      { text: JSON.stringify({ pins: [{ number: '9', noConnected: false }] }) },
    ];
    const toolCall = vi.fn(async () => responses.shift()!);

    await placeValidationComponents({
      toolCall,
      projectId: 'active',
      devices: { d0Uuid: 'u0', d0LibraryUuid: '', d1Uuid: 'u1', d1LibraryUuid: '' },
      reporter,
    });

    expect(reporter.fail).toHaveBeenCalledWith(
      'Native No Connect set/readback/clear',
      expect.stringContaining('component pin readback did not expose noConnected=true'),
    );
  });

  it('reports an invalid clear readback and uses the unknown pin primitive marker', async () => {
    const reporter = createReporter();
    const responses = [
      { text: JSON.stringify({ component: { primitiveId: 'r1' } }) },
      { text: JSON.stringify({ component: { primitiveId: 'r2' } }) },
      { text: JSON.stringify({ pins: [] }) },
      { text: JSON.stringify({ pins: [{ number: '9' }] }) },
      { text: JSON.stringify({ no_connected: true, verified: true }) },
      { text: JSON.stringify({ pins: [{ number: '9', noConnected: true }] }) },
      { text: JSON.stringify({ no_connected: true, verified: false }) },
    ];
    const toolCall = vi.fn(async () => responses.shift()!);

    await placeValidationComponents({
      toolCall,
      projectId: 'active',
      devices: { d0Uuid: 'u0', d0LibraryUuid: '', d1Uuid: 'u1', d1LibraryUuid: '' },
      reporter,
    });

    expect(reporter.ok).toHaveBeenCalledWith(
      'Read back native No Connect',
      'pinPrimitiveId=unknown',
    );
    expect(reporter.fail).toHaveBeenCalledWith(
      'Native No Connect set/readback/clear',
      expect.stringContaining('clear readback was not verified'),
    );
  });

  it('keeps unknown net IDs when creation fails or returns a payload without an ID', async () => {
    const reporter = createReporter();
    const toolCall = vi
      .fn()
      .mockRejectedValueOnce(new Error('flag creation failed'))
      .mockResolvedValueOnce({ text: '{}' });

    await expect(
      createValidationNetArtifacts({
        toolCall,
        projectId: 'active',
        netName: 'TEST_NET',
        reporter,
      }),
    ).resolves.toEqual({ flagPrimId: 'unknown', portPrimId: 'unknown' });
    expect(reporter.fail).toHaveBeenCalledWith('Create net flag', 'flag creation failed');
    expect(reporter.ok).toHaveBeenCalledWith('Create net port TEST_NET', 'primitiveId=unknown');
  });

  it('creates TEST_NET flag and port while preserving unknown-id fallbacks', async () => {
    const reporter = createReporter();
    const toolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ netFlag: { primitiveId: 'flag-1' } }) })
      .mockResolvedValueOnce({ text: 'not-json' });

    await expect(
      createValidationNetArtifacts({
        toolCall,
        projectId: 'active',
        netName: 'TEST_NET',
        reporter,
      }),
    ).resolves.toEqual({ flagPrimId: 'flag-1', portPrimId: 'unknown' });
    expect(toolCall).toHaveBeenNthCalledWith(1, 'easyeda_schematic_create_net_flag', {
      projectId: 'active',
      netName: 'TEST_NET',
      x: 300,
      y: 100,
      rotation: 0,
      confirmWrite: true,
    });
    expect(toolCall).toHaveBeenNthCalledWith(2, 'easyeda_schematic_create_net_port', {
      projectId: 'active',
      netName: 'TEST_NET',
      x: 300,
      y: 300,
      portType: 'passive',
      rotation: 0,
      confirmWrite: true,
    });
  });
});
