import { stableHash } from '../transactions/stable.js';
import type { Point, SchematicModel } from './geometry-model.js';

export interface FingerprintPinMembership {
  componentId: string;
  componentReference: string;
  pinId: string;
  pinNumber: string;
  netIds: string[];
}

export interface FingerprintWireEndpoint {
  endpoint: 'start' | 'end';
  kind: 'pin' | 'unresolved';
  token: string;
}

export interface FingerprintWire {
  wireId: string;
  netId?: string;
  netName?: string;
  endpoints: FingerprintWireEndpoint[];
}

export interface FingerprintNetLabelOrPort {
  id: string;
  kind: 'label' | 'sheet-port' | 'power-symbol';
  netName: string;
}

export interface FingerprintNoConnect {
  noConnectId: string;
  componentReference?: string;
  pinId?: string;
  pinNumber?: string;
}

export interface NormalizedConnectivity {
  pinNetMembership: FingerprintPinMembership[];
  wireEndpoints: FingerprintWire[];
  labelsAndPorts: FingerprintNetLabelOrPort[];
  noConnects: FingerprintNoConnect[];
}

export interface ConnectivityFingerprint {
  schemaVersion: 1;
  hash: string;
  normalized: NormalizedConnectivity;
}

export interface ConnectivityFingerprintOptions {
  endpointTolerance?: number;
}

export interface ConnectivityDiffEntry<T> {
  key: string;
  before?: T;
  after?: T;
}

export interface ConnectivityFingerprintDiff {
  equal: boolean;
  beforeHash: string;
  afterHash: string;
  pinNetMembership: ConnectivityDiffEntry<FingerprintPinMembership>[];
  wireEndpoints: ConnectivityDiffEntry<FingerprintWire>[];
  labelsAndPorts: ConnectivityDiffEntry<FingerprintNetLabelOrPort>[];
  noConnects: ConnectivityDiffEntry<FingerprintNoConnect>[];
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function endpointToken(
  point: Point | undefined,
  model: SchematicModel,
  tolerance: number,
  wireId: string,
  endpoint: 'start' | 'end',
): FingerprintWireEndpoint {
  if (point) {
    const matchingPin = model.pins
      .filter((pin) => pin.position && pointDistance(pin.position, point) <= tolerance)
      .sort((a, b) => a.canonicalPinId.localeCompare(b.canonicalPinId))[0];
    if (matchingPin) {
      return { endpoint, kind: 'pin', token: matchingPin.canonicalPinId };
    }
  }
  return { endpoint, kind: 'unresolved', token: `${wireId}:${endpoint}` };
}

function normalizePinMembership(model: SchematicModel): FingerprintPinMembership[] {
  const references = new Map(
    model.components.map((component) => [component.canonicalComponentId, component.reference]),
  );
  return model.pins
    .map((pin) => ({
      componentId: pin.canonicalComponentId,
      componentReference:
        references.get(pin.canonicalComponentId) ?? pin.reference ?? pin.canonicalComponentId,
      pinId: pin.canonicalPinId,
      pinNumber: pin.number,
      netIds: [...pin.netIds].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.pinId.localeCompare(b.pinId));
}

function normalizeWires(model: SchematicModel, endpointTolerance: number): FingerprintWire[] {
  return model.wires
    .map((wire) => {
      const first = wire.points[0];
      const last = wire.points.at(-1);
      return {
        wireId: wire.canonicalWireId,
        ...(wire.canonicalNetId ? { netId: wire.canonicalNetId } : {}),
        ...(wire.canonicalNetName ? { netName: wire.canonicalNetName } : {}),
        endpoints: [
          endpointToken(first, model, endpointTolerance, wire.canonicalWireId, 'start'),
          endpointToken(last, model, endpointTolerance, wire.canonicalWireId, 'end'),
        ],
      } satisfies FingerprintWire;
    })
    .sort((a, b) => a.wireId.localeCompare(b.wireId));
}

function normalizeLabelsAndPorts(model: SchematicModel): FingerprintNetLabelOrPort[] {
  const labels: FingerprintNetLabelOrPort[] = model.labels.map((label) => ({
    id: label.canonicalLabelId,
    kind: 'label',
    netName: label.canonicalNetName ?? '<unassigned>',
  }));
  const ports: FingerprintNetLabelOrPort[] = model.sheets.flatMap((sheet) =>
    [...sheet.portNames]
      .sort((a, b) => a.localeCompare(b))
      .map((portName, index) => ({
        id: `${sheet.canonicalSheetId}:port:${index}:${portName}`,
        kind: 'sheet-port' as const,
        netName: portName,
      })),
  );
  const powerSymbols: FingerprintNetLabelOrPort[] = model.powerSymbols.map((symbol) => ({
    id: symbol.canonicalPowerSymbolId,
    kind: 'power-symbol',
    netName: symbol.canonicalNetName ?? '<unassigned>',
  }));
  return [...labels, ...ports, ...powerSymbols].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeNoConnects(model: SchematicModel): FingerprintNoConnect[] {
  return model.noConnects
    .map((noConnect) => ({
      noConnectId: noConnect.canonicalNoConnectId,
      ...(noConnect.componentReference ? { componentReference: noConnect.componentReference } : {}),
      ...(noConnect.canonicalPinId ? { pinId: noConnect.canonicalPinId } : {}),
      ...(noConnect.pinNumber ? { pinNumber: noConnect.pinNumber } : {}),
    }))
    .sort((a, b) => a.noConnectId.localeCompare(b.noConnectId));
}

export function createConnectivityFingerprint(
  model: SchematicModel,
  options: ConnectivityFingerprintOptions = {},
): ConnectivityFingerprint {
  const endpointTolerance = Math.max(0, options.endpointTolerance ?? 0.001);
  const normalized: NormalizedConnectivity = {
    pinNetMembership: normalizePinMembership(model),
    wireEndpoints: normalizeWires(model, endpointTolerance),
    labelsAndPorts: normalizeLabelsAndPorts(model),
    noConnects: normalizeNoConnects(model),
  };
  return { schemaVersion: 1, hash: stableHash(normalized), normalized };
}

function structuredArrayDiff<T>(
  before: readonly T[],
  after: readonly T[],
  key: (value: T) => string,
): ConnectivityDiffEntry<T>[] {
  const beforeMap = new Map(before.map((value) => [key(value), value]));
  const afterMap = new Map(after.map((value) => [key(value), value]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  const result: ConnectivityDiffEntry<T>[] = [];
  for (const itemKey of keys) {
    const beforeValue = beforeMap.get(itemKey);
    const afterValue = afterMap.get(itemKey);
    if (
      beforeValue !== undefined &&
      afterValue !== undefined &&
      stableHash(beforeValue) === stableHash(afterValue)
    ) {
      continue;
    }
    result.push({
      key: itemKey,
      ...(beforeValue ? { before: beforeValue } : {}),
      ...(afterValue ? { after: afterValue } : {}),
    });
  }
  return result;
}

export function compareConnectivityFingerprints(
  before: ConnectivityFingerprint,
  after: ConnectivityFingerprint,
): ConnectivityFingerprintDiff {
  return {
    equal: before.hash === after.hash,
    beforeHash: before.hash,
    afterHash: after.hash,
    pinNetMembership: structuredArrayDiff(
      before.normalized.pinNetMembership,
      after.normalized.pinNetMembership,
      (item) => item.pinId,
    ),
    wireEndpoints: structuredArrayDiff(
      before.normalized.wireEndpoints,
      after.normalized.wireEndpoints,
      (item) => item.wireId,
    ),
    labelsAndPorts: structuredArrayDiff(
      before.normalized.labelsAndPorts,
      after.normalized.labelsAndPorts,
      (item) => item.id,
    ),
    noConnects: structuredArrayDiff(
      before.normalized.noConnects,
      after.normalized.noConnects,
      (item) => item.noConnectId,
    ),
  };
}
