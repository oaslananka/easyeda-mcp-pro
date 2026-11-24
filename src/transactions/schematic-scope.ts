import { TransactionError } from './manager.js';
import type { NativeSchematicScope } from './model.js';

type ScopeBridge = {
  call: <TParams, TResult>(method: string, params?: TParams) => Promise<TResult>;
};

type NativeReadResponse = { result?: unknown };

function nativeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Strict read-only native focus check; missing/ambiguous identity fails closed. */
export async function assertFocusedSchematicScope(
  bridge: ScopeBridge,
  projectId: string,
  expectedDocumentId?: string,
): Promise<NativeSchematicScope> {
  try {
    const projectResponse = await bridge.call<
      { path: string; args: unknown[] },
      NativeReadResponse
    >('api.read', { path: 'DMT_Project.getCurrentProjectInfo', args: [] });
    const documentResponse = await bridge.call<
      { path: string; args: unknown[] },
      NativeReadResponse
    >('api.read', { path: 'DMT_SelectControl.getCurrentDocumentInfo', args: [] });
    const project = nativeRecord(projectResponse?.result);
    const document = nativeRecord(documentResponse?.result);
    if (
      typeof projectId !== 'string' ||
      !projectId ||
      project.uuid !== projectId ||
      typeof document.uuid !== 'string' ||
      !document.uuid ||
      document.documentType !== 1 ||
      document.parentProjectUuid !== projectId ||
      (expectedDocumentId !== undefined && document.uuid !== expectedDocumentId)
    ) {
      throw new Error('Native schematic project/page identity mismatch');
    }
    return { projectId, documentId: document.uuid };
  } catch {
    throw new TransactionError(
      'TRANSACTION_INVALID_STATE',
      'Focused native schematic project/page cannot be verified for this transactional operation',
    );
  }
}

/** Applied by the native extension at the last available pre-write boundary. */
export function nativeSchematicTarget(scope: NativeSchematicScope) {
  return {
    expectedProjectUuid: scope.projectId,
    expectedSchematicPageUuid: scope.documentId,
  };
}
