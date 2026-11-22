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

export interface PrivateInPortProfile {
  projectId: string;
  documentId: string;
  originalPrimitiveId: string;
  net: string;
  x: number;
  y: number;
  componentCount: 3;
  wireCount: 0;
  pagePinCount: 0;
  embeddedPinCount: 1;
  attributeCount: 47;
  attributeFingerprint: string;
}

const VERIFIED_IN_PORT_ATTRIBUTES_SHA256 =
  '3901dab9df8ea0694ee7c0b1dad50c139fc1169ccab04a8a09afc046c4adb2b3';

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

function exactObservedInventory(profile: PrivateInPortProfile): boolean {
  return (
    profile.componentCount === 3 &&
    profile.wireCount === 0 &&
    profile.pagePinCount === 0 &&
    profile.embeddedPinCount === 1 &&
    profile.attributeCount === 47 &&
    profile.attributeFingerprint === VERIFIED_IN_PORT_ATTRIBUTES_SHA256
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
  let active: unknown;
  let document: unknown;
  try {
    active = await deps.callFirst(['DMT_Project.getCurrentProjectInfo']);
    document = await deps.callFirst(['DMT_SelectControl.getCurrentDocumentInfo']);
  } catch {
    return refuse();
  }
  if (
    !isRecord(active) ||
    active.uuid !== ctx.projectId ||
    !isRecord(document) ||
    document.uuid !== ctx.documentId ||
    document.parentProjectUuid !== ctx.projectId ||
    document.documentType !== 1
  ) {
    refuse();
  }
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
