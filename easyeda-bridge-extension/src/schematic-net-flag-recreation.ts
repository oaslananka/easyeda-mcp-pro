import type { SchematicPrimitiveSnapshot } from './schematic-transaction-operations.js';
import type { SchematicSnapshotRecreationDependencies } from './schematic-snapshot-recreation.js';

type NativeContext = NonNullable<SchematicPrimitiveSnapshot['nativeContext']>;
type NativeProject = { uuid?: unknown };
type NativeDocument = { uuid?: unknown; parentProjectUuid?: unknown; documentType?: unknown };

const POWER_IDENTIFICATIONS = new Set(['Power', 'Ground', 'AnalogGround', 'ProtectGround']);

function hasExactPowerFlagProperties(property: Record<string, unknown>): boolean {
  return (
    typeof property.identification === 'string' &&
    POWER_IDENTIFICATIONS.has(property.identification) &&
    typeof property.net === 'string' &&
    property.net.trim().length > 0 &&
    typeof property.mirror === 'boolean' &&
    typeof property.rotation === 'number' &&
    Number.isFinite(property.rotation)
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
    !hasExactPowerFlagProperties(property)
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
 * The native API is BETA. This helper does not authorize a transactional
 * delete: server preflight still denies netflag, netport and component kinds.
 * Actual enabled rollback requires a disposable-editor persistence test.
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
