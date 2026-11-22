import type { SchematicPrimitiveSnapshot } from './schematic-transaction-operations.js';
import type { ApiRuntime } from './api-runtime.js';
import { isRecord } from './utils.js';

/**
 * Verified private zero-wire V4.1.105 IN port page fingerprint shape.
 * Supplied only by the offline fixture harness, never by an MCP request.
 * The fingerprint retains all 47 rows and normalizes only sheet @Update Time
 * (a generated timestamp). Before, after and cold-reopened data then agree.
 * The literal inventory sizes correspond to the real QA_IN-port cold reopen.
 * Not a claim of global netlist disconnection or an editor-wide writer lock.
 */
export interface PrivateInPortRecreationDependencies {
  callFirst: ApiRuntime['callFirst'];
  createBridgeError(code: string, message: string, suggestion: string): Error;
  getEasyedaVersion?(): string | undefined;
  allowExperimentalInPortRecreation?(): boolean;
  privateInPortProfile?: PrivateInPortProfile;
}

export interface PrivateInPortWireEvidence {
  primitiveId: string;
  net: string;
  line: readonly [number, number, number, number];
}

export interface PrivateInPortProfile {
  projectId: string;
  documentId: string;
  originalPrimitiveId: string;
  net: string;
  x: number;
  y: number;
  componentCount: 3;
  wireCount: 0 | 1;
  pagePinCount: 0;
  embeddedPinCount: 1;
  attributeCount: 47 | 49;
  attributeFingerprint: string;
  /** Only a separately captured, private one-wire native QA fixture. */
  connectedWire?: PrivateInPortWireEvidence;
}

const VERIFIED_ISOLATED_ATTRIBUTES_SHA256 =
  '3901dab9df8ea0694ee7c0b1dad50c139fc1169ccab04a8a09afc046c4adb2b3';
const VERIFIED_WIRED_ATTRIBUTES_SHA256 =
  '45fca1b2e12f2e095ad3855d25a3f8bbe1366a91f3b69a4fdeca9c2a642b0c9d';

const V4_IN_SYMBOL = Object.freeze({
  libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
  uuid: '21c0c70348655df0',
  name: 'Netport-IN',
});

function exactSymbol(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.libraryUuid === V4_IN_SYMBOL.libraryUuid &&
    value.uuid === V4_IN_SYMBOL.uuid &&
    value.name === V4_IN_SYMBOL.name
  );
}

function exactFixtureScope(
  snapshot: SchematicPrimitiveSnapshot,
  profile: PrivateInPortProfile,
): boolean {
  const ctx = snapshot.nativeContext;
  return (
    snapshot.primitiveKind === 'netport' &&
    snapshot.componentType === 'netport' &&
    ctx?.editorVersion === '4.1.105' &&
    !!ctx.projectId &&
    !!ctx.documentId &&
    ctx.projectId === profile.projectId &&
    ctx.documentId === profile.documentId &&
    snapshot.primitiveId === profile.originalPrimitiveId &&
    snapshot.primitiveId.length > 0
  );
}

function exactOrthogonalPortLine(line: readonly number[], profile: PrivateInPortProfile): boolean {
  if (!Array.isArray(line) || line.length !== 4) return false;
  const touchesPort =
    (line[0] === profile.x && line[1] === profile.y) ||
    (line[2] === profile.x && line[3] === profile.y);
  return (
    line.every((point) => Number.isSafeInteger(point)) &&
    touchesPort &&
    (line[0] !== line[2] || line[1] !== line[3]) &&
    (line[0] === line[2] || line[1] === line[3])
  );
}

function exactConnectedWireEvidence(profile: PrivateInPortProfile): boolean {
  const wire = profile.connectedWire;
  return (
    !!wire &&
    isRecord(wire) &&
    Object.keys(wire).length === 3 &&
    typeof wire.primitiveId === 'string' &&
    wire.primitiveId.length > 0 &&
    wire.primitiveId !== profile.originalPrimitiveId &&
    wire.net === profile.net &&
    exactOrthogonalPortLine(wire.line, profile)
  );
}

function exactObservedInventory(profile: PrivateInPortProfile): boolean {
  if (profile.componentCount !== 3 || profile.pagePinCount !== 0 || profile.embeddedPinCount !== 1)
    return false;
  if (profile.wireCount === 0) {
    return (
      profile.attributeCount === 47 &&
      profile.attributeFingerprint === VERIFIED_ISOLATED_ATTRIBUTES_SHA256 &&
      profile.connectedWire === undefined
    );
  }
  return (
    profile.wireCount === 1 &&
    profile.attributeCount === 49 &&
    profile.attributeFingerprint === VERIFIED_WIRED_ATTRIBUTES_SHA256 &&
    exactConnectedWireEvidence(profile)
  );
}

function exactObservedPort(
  property: Record<string, unknown>,
  profile: PrivateInPortProfile,
): boolean {
  const keys = ['direction', 'mirror', 'nativeSymbol', 'net', 'rotation', 'x', 'y'];
  if (
    Object.keys(property).length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(property, key))
  )
    return false;
  return (
    property.direction === 'IN' &&
    exactSymbol(property.nativeSymbol) &&
    typeof property.net === 'string' &&
    property.net.length > 0 &&
    property.net.length <= 1024 &&
    property.net === profile.net &&
    Number.isSafeInteger(property.x) &&
    Number.isSafeInteger(property.y) &&
    property.x === profile.x &&
    property.y === profile.y &&
    property.rotation === 0 &&
    property.mirror === false
  );
}

function verifiedFixtureDescriptor(
  snapshot: SchematicPrimitiveSnapshot,
  profile?: PrivateInPortProfile,
): boolean {
  return (
    profile !== undefined &&
    exactFixtureScope(snapshot, profile) &&
    exactObservedInventory(profile) &&
    exactObservedPort(snapshot.property, profile)
  );
}

function readState(primitive: unknown, key: string): unknown {
  if (!isRecord(primitive)) return undefined;
  const getter = primitive['getState_' + key];
  try {
    return typeof getter === 'function' ? getter.call(primitive) : undefined;
  } catch {
    return undefined;
  }
}

function matchesWire(wire: unknown, expected: PrivateInPortWireEvidence): boolean {
  return (
    readState(wire, 'PrimitiveId') === expected.primitiveId &&
    readState(wire, 'Net') === expected.net &&
    JSON.stringify(readState(wire, 'Line')) === JSON.stringify(expected.line)
  );
}

async function focusedScopeMatches(
  deps: PrivateInPortRecreationDependencies,
  projectId: string,
  documentId: string,
): Promise<boolean> {
  let active: unknown;
  let document: unknown;
  try {
    active = await deps.callFirst(['DMT_Project.getCurrentProjectInfo']);
    document = await deps.callFirst(['DMT_SelectControl.getCurrentDocumentInfo']);
  } catch {
    return false;
  }
  return (
    isRecord(active) &&
    active.uuid === projectId &&
    isRecord(document) &&
    document.uuid === documentId &&
    document.parentProjectUuid === projectId &&
    document.documentType === 1
  );
}

/**
 * Read the *current native editor* state after the exact port was deleted.
 * The private pre-deletion profile is not trusted as proof of live wire state.
 * This is a narrow fixture inventory, not an authoritative project netlist.
 */
function exactRemainingCounts(
  absent: unknown,
  wires: unknown,
  components: unknown,
  attributes: unknown,
  pagePins: unknown,
  profile: PrivateInPortProfile,
): boolean {
  return (
    (absent === undefined || absent === null) &&
    Array.isArray(wires) &&
    wires.length === profile.wireCount &&
    Array.isArray(components) &&
    components.length === 2 &&
    Array.isArray(attributes) &&
    attributes.length === profile.attributeCount - 9 &&
    Array.isArray(pagePins) &&
    pagePins.length === 0
  );
}

function exactRemainingComponents(components: unknown[]): boolean {
  const kinds = components.map((item) => readState(item, 'ComponentType')).sort();
  if (JSON.stringify(kinds) !== JSON.stringify(['netflag', 'sheet'])) return false;
  const ground = components.find((item) => readState(item, 'ComponentType') === 'netflag');
  return readState(ground, 'Net') === 'GND';
}

async function matchesNativeAfterDelete(
  deps: PrivateInPortRecreationDependencies,
  profile: PrivateInPortProfile,
): Promise<boolean> {
  let absent: unknown;
  let wires: unknown;
  let components: unknown;
  let attributes: unknown;
  let pagePins: unknown;
  try {
    absent = await deps.callFirst(
      ['SCH_PrimitiveComponent.get', 'sch_PrimitiveComponent.get'],
      profile.originalPrimitiveId,
    );
    wires = await deps.callFirst(['SCH_PrimitiveWire.getAll', 'sch_PrimitiveWire.getAll']);
    components = await deps.callFirst([
      'SCH_PrimitiveComponent.getAll',
      'sch_PrimitiveComponent.getAll',
    ]);
    attributes = await deps.callFirst([
      'SCH_PrimitiveAttribute.getAll',
      'sch_PrimitiveAttribute.getAll',
    ]);
    pagePins = await deps.callFirst(['SCH_PrimitivePin.getAll', 'sch_PrimitivePin.getAll']);
  } catch {
    return false;
  }
  if (!exactRemainingCounts(absent, wires, components, attributes, pagePins, profile)) {
    return false;
  }
  if (!exactRemainingComponents(components as unknown[])) return false;
  if (profile.wireCount === 0) return true;
  return !!profile.connectedWire && matchesWire((wires as unknown[])[0], profile.connectedWire);
}

/**
 * Narrow BETA API experiment for the exact isolated IN-port fixture.
 * Normal dispatcher never exposes the opt-in or trusted profile, and the
 * production delete allowlist continues to deny all netports.
 */
export async function recreateVerifiedPrivateInPort(
  deps: PrivateInPortRecreationDependencies,
  snapshot: SchematicPrimitiveSnapshot,
): Promise<unknown> {
  const refuse = (): never => {
    throw deps.createBridgeError(
      'UNSUPPORTED_RUNTIME',
      'Native IN netport recreation lacks a verified private fixture descriptor or supported scope',
      'Leave net ports intact; native topology and complete attribute recovery are not production-verified.',
    );
  };
  if (
    deps.allowExperimentalInPortRecreation?.() !== true ||
    deps.getEasyedaVersion?.() !== '4.1.105' ||
    !verifiedFixtureDescriptor(snapshot, deps.privateInPortProfile)
  ) {
    refuse();
  }
  const ctx = snapshot.nativeContext;
  if (!ctx) return refuse();
  const privateProfile = deps.privateInPortProfile;
  if (!privateProfile) return refuse();
  if (!(await focusedScopeMatches(deps, ctx.projectId, ctx.documentId))) refuse();
  if (!(await matchesNativeAfterDelete(deps, privateProfile))) refuse();
  // A stale focused page after the read can produce a wrong-project write.
  if (!(await focusedScopeMatches(deps, ctx.projectId, ctx.documentId))) refuse();
  return deps.callFirst(
    ['SCH_PrimitiveComponent.createNetPort', 'sch_PrimitiveComponent.createNetPort'],
    'IN',
    snapshot.property.net,
    snapshot.property.x,
    snapshot.property.y,
    0,
    false,
  );
}
