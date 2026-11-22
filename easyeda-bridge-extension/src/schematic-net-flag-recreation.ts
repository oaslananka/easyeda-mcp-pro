import type { SchematicPrimitiveSnapshot } from './schematic-transaction-operations.js';
import {
  isVerifiedV4GroundSymbol,
  type PrivateGroundProfile,
} from './schematic-native-ground-identity.js';
import type { SchematicSnapshotRecreationDependencies } from './schematic-snapshot-recreation.js';

type NativeContext = NonNullable<SchematicPrimitiveSnapshot['nativeContext']>;
type NativeProject = { uuid?: unknown };
type NativeDocument = { uuid?: unknown; parentProjectUuid?: unknown; documentType?: unknown };

function hasExactPowerFlagProperties(
  property: Record<string, unknown>,
  profile?: PrivateGroundProfile,
): boolean {
  return (
    property.identification === 'Ground' &&
    property.net === 'GND' &&
    isVerifiedV4GroundSymbol(property.nativeSymbol, profile) &&
    property.mirror === false &&
    property.rotation === 0 &&
    Number.isSafeInteger(property.x) &&
    Number.isSafeInteger(property.y)
  );
}

function matchesGroundTopology(
  evidence: NonNullable<SchematicPrimitiveSnapshot['nativeIsolation']>,
  profile?: PrivateGroundProfile,
): boolean {
  return (
    evidence.componentCount === (profile?.sheetCount === 0 ? 1 : 2) &&
    evidence.wireCount === 0 &&
    evidence.pagePinCount === 0 &&
    evidence.embeddedPinCount === 1
  );
}

/** This is a bounded fixture descriptor check, not an authorization token.
 * Production still denies marker deletion and does not enable this capability.
 */
function hasMatchingGroundIsolation(
  snapshot: SchematicPrimitiveSnapshot,
  profile?: PrivateGroundProfile,
): boolean {
  const evidence = snapshot.nativeIsolation;
  return (
    evidence?.kind === 'verified-disconnected-ground/v2' &&
    typeof snapshot.primitiveId === 'string' &&
    snapshot.primitiveId.length > 0 &&
    evidence.markerId === snapshot.primitiveId &&
    matchesGroundTopology(evidence, profile) &&
    Number.isInteger(evidence.attributeCount) &&
    evidence.attributeCount > 0 &&
    evidence.attributeCount <= 256 &&
    typeof evidence.attributeFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(evidence.attributeFingerprint)
  );
}

function requirePowerDescriptor(
  deps: SchematicSnapshotRecreationDependencies,
  snapshot: SchematicPrimitiveSnapshot,
): NativeContext {
  const property = snapshot.property;
  if (
    deps.allowExperimentalPowerNetFlagRecreation?.() !== true ||
    deps.getEasyedaVersion?.() !== '4.1.105' ||
    snapshot.componentType !== 'netflag' ||
    !hasExactPowerFlagProperties(property, deps.privateGroundProfile) ||
    !hasMatchingGroundIsolation(snapshot, deps.privateGroundProfile)
  ) {
    throw deps.createBridgeError(
      'UNSUPPORTED_RUNTIME',
      'Power net flag recreation lacks a verified native creation descriptor or supported editor version',
      'Keep the flag intact; inspect identification, net, orientation, and native version before retrying.',
    );
  }

  const context = snapshot.nativeContext;
  if (
    !context ||
    context.editorVersion !== '4.1.105' ||
    !context.projectId ||
    !context.documentId
  ) {
    throw deps.createBridgeError(
      'UNSUPPORTED_RUNTIME',
      'Missing native project and focused page binding for power net flag recreation',
      'Reinspect the original primitive in the focused editor before attempting rollback.',
    );
  }
  return context;
}

async function requireCurrentNativeScope(
  deps: SchematicSnapshotRecreationDependencies,
  context: NativeContext,
): Promise<void> {
  const activeProject = (await deps.callFirst(['DMT_Project.getCurrentProjectInfo'])) as
    NativeProject | undefined;
  const focusedPage = (await deps.callFirst(['DMT_SelectControl.getCurrentDocumentInfo'])) as
    NativeDocument | undefined;
  if (
    activeProject?.uuid !== context.projectId ||
    focusedPage?.uuid !== context.documentId ||
    focusedPage?.parentProjectUuid !== context.projectId ||
    focusedPage?.documentType !== 1
  ) {
    throw deps.createBridgeError(
      'UNSUPPORTED_RUNTIME',
      'Power net flag snapshot belongs to a different native project or focused page',
      'Select the original schematic page and inspect the primitive again before retrying.',
    );
  }
}

/**
 * The native API is BETA. The exact disconnected Ground-GND native
 * create/delete/recreate round-trip survived three independent cold reopens.
 * This helper remains fixture-only until the transaction engine has a proven
 * pre-delete connection guard and complete rollback reconciliation.
 * Production preflight still denies all marker and component deletions.
 */
export async function recreateVerifiedPowerNetFlag(
  deps: SchematicSnapshotRecreationDependencies,
  snapshot: SchematicPrimitiveSnapshot,
  requiredNumber: (property: Record<string, unknown>, key: string) => number,
): Promise<unknown> {
  const context = requirePowerDescriptor(deps, snapshot);
  await requireCurrentNativeScope(deps, context);
  const property = snapshot.property;
  const x = requiredNumber(property, 'x');
  const y = requiredNumber(property, 'y');
  return deps.callFirst(
    ['SCH_PrimitiveComponent.createNetFlag', 'sch_PrimitiveComponent.createNetFlag'],
    property.identification,
    property.net,
    x,
    y,
    property.rotation,
    property.mirror,
  );
}
