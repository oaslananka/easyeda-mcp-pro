import type { ApiRuntime } from './api-runtime.js';
import type { SchematicTransactionOperations } from './schematic-transaction-operations.js';

interface NativeWireMonitorDependencies {
  transaction: SchematicTransactionOperations;
  readFirstPath: ApiRuntime['readFirstPath'];
  logRecoverableError: (message: string, error: unknown) => void;
}

const LISTENER_ID = 'easyeda-mcp-pro-schematic-wire-freshness';

/** Do not infer native wire freshness from the eventually consistent getAll(). */
async function handleNativePrimitiveEvent(
  kind: string,
  props: { primitiveIds?: string[] } | undefined,
  dependencies: NativeWireMonitorDependencies,
): Promise<void> {
  const { transaction, readFirstPath, logRecoverableError } = dependencies;
  const token = transaction.beginNativeWireMutation();
  const ids = props?.primitiveIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id)) {
    return; // Unknown mutation. Leave fail-closed until a new dispatcher.
  }
  if (kind === 'delete') {
    // Native get(id) cannot classify a primitive after deletion. The next
    // move requires both direct and collection wire reads to exclude the ID.
    transaction.finishNativeWireMutation(token, 'delete', ids);
    return;
  }
  const wireClass = readFirstPath<any>(['SCH_PrimitiveWire', 'sch_PrimitiveWire']);
  const componentClass = readFirstPath<any>([
    'SCH_PrimitiveComponent',
    'SCH_PrimitiveComponent3',
    'sch_PrimitiveComponent',
  ]);
  if (typeof wireClass?.get !== 'function' || typeof componentClass?.get !== 'function') return;
  try {
    const kinds = await Promise.all(
      ids.map(async (id) => {
        const wire = await wireClass.get(id);
        if (wire) return 'wire';
        const component = await componentClass.get(id);
        return component ? 'component' : 'unknown';
      }),
    );
    if (kind === 'create' && kinds.every((value) => value === 'component')) {
      transaction.cancelNativeWireMutation(token);
    } else if (kind === 'create' && kinds.every((value) => value === 'wire')) {
      transaction.finishNativeWireMutation(token, 'create', ids);
    }
    // Unknown type or wire move/change cannot be declared safe by the
    // potentially stale batch reads. Keep the fail-closed token.
  } catch (error) {
    logRecoverableError('native schematic event could not be classified safely', error);
  }
}

/** A missing/unconfirmed listener cannot authorize a component move. */
export function installNativeSchematicWireEventMonitor(
  dependencies: NativeWireMonitorDependencies,
): void {
  const { transaction, readFirstPath, logRecoverableError } = dependencies;
  const events = readFirstPath<any>(['SCH_Event', 'sch_Event']);
  let ready = false;
  try {
    if (
      events &&
      typeof events.addPrimitiveEventListener === 'function' &&
      typeof events.isEventListenerAlreadyExist === 'function'
    ) {
      if (events.isEventListenerAlreadyExist(LISTENER_ID)) {
        if (typeof events.removeEventListener !== 'function') {
          throw new Error('Cannot remove old native schematic event listener');
        }
        events.removeEventListener(LISTENER_ID);
      }
      events.addPrimitiveEventListener(
        LISTENER_ID,
        'all',
        (kind: string, props: { primitiveIds?: string[] }) =>
          handleNativePrimitiveEvent(kind, props, dependencies),
        false,
      );
      ready = events.isEventListenerAlreadyExist(LISTENER_ID) === true;
    }
  } catch (error) {
    logRecoverableError('native schematic event listener unavailable', error);
  }
  transaction.setNativeEventMonitorReady(ready);
}
