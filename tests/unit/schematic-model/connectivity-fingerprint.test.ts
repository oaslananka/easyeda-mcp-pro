import { describe, expect, it } from 'vitest';

import { buildSchematicModel } from '../../../src/schematic-model/model-builder.js';
import {
  compareConnectivityFingerprints,
  createConnectivityFingerprint,
} from '../../../src/schematic-model/connectivity-fingerprint.js';

function rawSchematic(offset = 0, detachStart = false, netName = 'SIG') {
  const moved = (x: number, y: number) => ({ x: x + offset, y: y + offset });
  return {
    document: { documentId: 'doc-layout' },
    components: [
      {
        runtimePrimitiveId: 'primitive-U1',
        reference: 'U1',
        componentType: 'IC',
        position: moved(20, 20),
        pins: [
          { runtimePrimitiveId: 'pin-U1-1', number: '1', name: 'OUT', position: moved(30, 20) },
        ],
      },
      {
        runtimePrimitiveId: 'primitive-J1',
        reference: 'J1',
        componentType: 'connector',
        position: moved(100, 20),
        pins: [
          { runtimePrimitiveId: 'pin-J1-1', number: '1', name: 'IN', position: moved(90, 20) },
          { runtimePrimitiveId: 'pin-J1-2', number: '2', name: 'NC', position: moved(90, 30) },
        ],
      },
    ],
    nets: [
      {
        runtimePrimitiveId: 'net-1',
        name: netName,
        nodes: [{ pinPrimitiveId: 'pin-U1-1' }, { pinPrimitiveId: 'pin-J1-1' }],
      },
    ],
    wires: [
      {
        runtimePrimitiveId: 'wire-1',
        netName,
        points: [detachStart ? { x: 30, y: 20 } : moved(30, 20), moved(90, 20)],
      },
    ],
    labels: [{ runtimePrimitiveId: 'label-1', netName, position: moved(60, 20) }],
    powerSymbols: [
      { runtimePrimitiveId: 'power-1', netName: 'GND', position: moved(50, 10), isPowerFlag: true },
    ],
    noConnects: [
      {
        runtimePrimitiveId: 'nc-1',
        componentReference: 'J1',
        pinNumber: '2',
        pinPrimitiveId: 'pin-J1-2',
        position: moved(90, 30),
      },
    ],
    sheets: [{ runtimePrimitiveId: 'sheet-1', name: 'Main', portNames: [netName, 'GND'] }],
  };
}

describe('connectivity fingerprints', () => {
  it('is stable when components, pins, wires, labels and notes move cosmetically together', () => {
    const before = createConnectivityFingerprint(buildSchematicModel(rawSchematic()));
    const after = createConnectivityFingerprint(buildSchematicModel(rawSchematic(200)));

    expect(after.hash).toBe(before.hash);
    expect(compareConnectivityFingerprints(before, after)).toMatchObject({
      equal: true,
      pinNetMembership: [],
      wireEndpoints: [],
      labelsAndPorts: [],
      noConnects: [],
    });
    expect(JSON.stringify(before.normalized)).not.toContain('"position"');
  });

  it('includes pin-to-net membership, logical wire endpoints, labels/ports and NC state', () => {
    const fingerprint = createConnectivityFingerprint(buildSchematicModel(rawSchematic()));
    expect(fingerprint.normalized.pinNetMembership).toHaveLength(3);
    expect(fingerprint.normalized.wireEndpoints[0]?.endpoints.map((item) => item.kind)).toEqual([
      'pin',
      'pin',
    ]);
    expect(fingerprint.normalized.labelsAndPorts.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['label', 'sheet-port', 'power-symbol']),
    );
    expect(fingerprint.normalized.noConnects).toHaveLength(1);
  });

  it('returns a structured wire endpoint diff when movement detaches a pin', () => {
    const before = createConnectivityFingerprint(buildSchematicModel(rawSchematic()));
    const detached = createConnectivityFingerprint(buildSchematicModel(rawSchematic(200, true)));
    const diff = compareConnectivityFingerprints(before, detached);

    expect(diff.equal).toBe(false);
    expect(diff.wireEndpoints).toHaveLength(1);
    expect(diff.wireEndpoints[0]?.before?.endpoints[0]?.kind).toBe('pin');
    expect(diff.wireEndpoints[0]?.after?.endpoints[0]?.kind).toBe('unresolved');
  });

  it('returns structured membership and label/port diffs for electrical net changes', () => {
    const before = createConnectivityFingerprint(buildSchematicModel(rawSchematic()));
    const after = createConnectivityFingerprint(buildSchematicModel(rawSchematic(0, false, 'ALT')));
    const diff = compareConnectivityFingerprints(before, after);

    expect(diff.equal).toBe(false);
    expect(diff.pinNetMembership.length).toBeGreaterThan(0);
    expect(diff.labelsAndPorts.length).toBeGreaterThan(0);
    expect(diff.beforeHash).not.toBe(diff.afterHash);
  });
});
