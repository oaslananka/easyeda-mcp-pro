import { describe, expect, it, vi } from 'vitest';
import { installNativeSchematicWireEventMonitor } from '../src/schematic-wire-event-monitor.js';

type MonitorOptions = Parameters<typeof installNativeSchematicWireEventMonitor>[0];
type EventHandler = (kind: string, props?: { primitiveIds?: string[] }) => Promise<void>;

function subject(
  overrides: {
    eventMethods?: Record<string, unknown> | null;
    wireGet?: (id: string) => Promise<unknown>;
    componentGet?: (id: string) => Promise<unknown>;
  } = {},
) {
  let callback: EventHandler | undefined;
  const ids = new Set<string>();
  const defaultEvents = {
    addPrimitiveEventListener: vi.fn((name: string, _kind: string, fn: EventHandler) => {
      callback = fn;
      ids.add(name);
    }),
    isEventListenerAlreadyExist: vi.fn((name: string) => ids.has(name)),
    removeEventListener: vi.fn((name: string) => ids.delete(name)),
  };
  const events = overrides.eventMethods === undefined ? defaultEvents : overrides.eventMethods;
  const transaction = {
    beginNativeWireMutation: vi.fn().mockReturnValue(7),
    finishNativeWireMutation: vi.fn(),
    cancelNativeWireMutation: vi.fn(),
    setNativeEventMonitorReady: vi.fn(),
  };
  const logRecoverableError = vi.fn();
  const readFirstPath = vi.fn((paths: string[]) => {
    const path = paths[0];
    if (path === 'SCH_Event') return events;
    if (path === 'SCH_PrimitiveWire') {
      return { get: overrides.wireGet ?? vi.fn().mockResolvedValue(undefined) };
    }
    if (path === 'SCH_PrimitiveComponent') {
      return { get: overrides.componentGet ?? vi.fn().mockResolvedValue(undefined) };
    }
    return undefined;
  });
  installNativeSchematicWireEventMonitor({
    transaction: transaction as unknown as MonitorOptions['transaction'],
    readFirstPath: readFirstPath as unknown as MonitorOptions['readFirstPath'],
    logRecoverableError,
  });
  return {
    transaction,
    events: defaultEvents,
    logRecoverableError,
    fire: async (kind: string, props?: { primitiveIds?: string[] }) => {
      if (!callback) throw new Error('Event listener absent');
      await callback(kind, props);
    },
  };
}

describe('native schematic primitive event freshness (#945)', () => {
  it('registers a listener for all primitives and tracks real GUI-created wires by ID', async () => {
    const { fire, transaction, events } = subject({
      wireGet: async (id) => ({ primitiveId: id, line: [0, 0, 40, 0] }),
    });
    expect(events.addPrimitiveEventListener).toHaveBeenCalledWith(
      'easyeda-mcp-pro-schematic-wire-freshness',
      'all',
      expect.any(Function),
      false,
    );
    expect(transaction.setNativeEventMonitorReady).toHaveBeenCalledWith(true);
    await fire('create', { primitiveIds: ['wire-ui'] });
    expect(transaction.finishNativeWireMutation).toHaveBeenCalledWith(7, 'create', ['wire-ui']);
  });

  it('holds an unknown GUI event without a stable primitive ID', async () => {
    const { transaction, fire } = subject();
    await fire('create');
    expect(transaction.beginNativeWireMutation).toHaveBeenCalledOnce();
    expect(transaction.finishNativeWireMutation).not.toHaveBeenCalled();
    expect(transaction.cancelNativeWireMutation).not.toHaveBeenCalled();
  });

  it('tracks deletions conservatively because the primitive type may no longer be readable', async () => {
    const { fire, transaction } = subject();
    await fire('delete', { primitiveIds: ['wire-removed'] });
    expect(transaction.finishNativeWireMutation).toHaveBeenCalledWith(7, 'delete', [
      'wire-removed',
    ]);
    expect(transaction.cancelNativeWireMutation).not.toHaveBeenCalled();
  });

  it('keeps non-wire GUI component movement uncertain until connectivity can be rechecked', async () => {
    const { fire, transaction } = subject({
      componentGet: async () => ({ primitiveId: 'component-ui' }),
    });
    await fire('change', { primitiveIds: ['component-ui'] });
    expect(transaction.finishNativeWireMutation).not.toHaveBeenCalled();
    expect(transaction.cancelNativeWireMutation).not.toHaveBeenCalled();
  });

  it('does not block normal component placement when the native create is unambiguously non-wire', async () => {
    const { fire, transaction } = subject({
      componentGet: async () => ({ primitiveId: 'component-created' }),
    });
    await fire('create', { primitiveIds: ['component-created'] });
    expect(transaction.cancelNativeWireMutation).toHaveBeenCalledWith(7);
    expect(transaction.finishNativeWireMutation).not.toHaveBeenCalled();
  });

  it('fails closed when exact primitive type lookup throws during an editor change', async () => {
    const error = new Error('native event API timeout');
    const { fire, transaction, logRecoverableError } = subject({
      wireGet: async () => {
        throw error;
      },
    });
    await fire('create', { primitiveIds: ['maybe-wire'] });
    expect(transaction.finishNativeWireMutation).not.toHaveBeenCalled();
    expect(transaction.cancelNativeWireMutation).not.toHaveBeenCalled();
    expect(logRecoverableError).toHaveBeenCalledWith(
      'native schematic event could not be classified safely',
      error,
    );
  });

  it('refuses event trust when the existing listener cannot be replaced', () => {
    const logRecoverableError = vi.fn();
    const setNativeEventMonitorReady = vi.fn();
    installNativeSchematicWireEventMonitor({
      transaction: { setNativeEventMonitorReady } as unknown as MonitorOptions['transaction'],
      readFirstPath: (() => ({
        addPrimitiveEventListener: vi.fn(),
        isEventListenerAlreadyExist: () => true,
      })) as unknown as MonitorOptions['readFirstPath'],
      logRecoverableError,
    });
    expect(setNativeEventMonitorReady).toHaveBeenCalledWith(false);
    expect(logRecoverableError).toHaveBeenCalledWith(
      'native schematic event listener unavailable',
      expect.objectContaining({ message: 'Cannot remove old native schematic event listener' }),
    );
  });

  it('replaces an existing listener only after removing it and confirming registration', () => {
    let installed = true;
    const removed = vi.fn(() => {
      installed = false;
    });
    const added = vi.fn(() => {
      installed = true;
    });
    const setNativeEventMonitorReady = vi.fn();
    installNativeSchematicWireEventMonitor({
      transaction: { setNativeEventMonitorReady } as unknown as MonitorOptions['transaction'],
      readFirstPath: (() => ({
        addPrimitiveEventListener: added,
        isEventListenerAlreadyExist: () => installed,
        removeEventListener: removed,
      })) as unknown as MonitorOptions['readFirstPath'],
      logRecoverableError: vi.fn(),
    });
    expect(removed).toHaveBeenCalledOnce();
    expect(added).toHaveBeenCalledOnce();
    expect(setNativeEventMonitorReady).toHaveBeenCalledWith(true);
  });

  it('fails closed when native event registration throws', () => {
    const logger = vi.fn();
    const setNativeEventMonitorReady = vi.fn();
    const failure = new Error('native event registrar unavailable');
    installNativeSchematicWireEventMonitor({
      transaction: { setNativeEventMonitorReady } as unknown as MonitorOptions['transaction'],
      readFirstPath: (() => ({
        addPrimitiveEventListener: () => {
          throw failure;
        },
        isEventListenerAlreadyExist: () => false,
      })) as unknown as MonitorOptions['readFirstPath'],
      logRecoverableError: logger,
    });
    expect(setNativeEventMonitorReady).toHaveBeenCalledWith(false);
    expect(logger).toHaveBeenCalledWith('native schematic event listener unavailable', failure);
  });

  it('fails closed if the native event surface is missing', () => {
    const { transaction } = subject({ eventMethods: null });
    expect(transaction.setNativeEventMonitorReady).toHaveBeenCalledWith(false);
  });
});
