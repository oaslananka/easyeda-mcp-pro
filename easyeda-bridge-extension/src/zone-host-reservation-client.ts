import type { RuntimeTimerHandle, RuntimeTimers } from './runtime-timers.js';
import type { ZoneFenceLock } from './zone-fence-lock.js';

/**
 * Private extension-side local-Bridge transport for #480.
 *
 * Acquiring the HOST reservation never authorizes a PCB write. The candidate
 * zone adapter additionally needs persistent native SYS_Storage fence readback,
 * verified exact project/geometry, independent recovery and a separately
 * approved tool invocation. This client is intentionally not a public API.
 */
export const HOST_NATIVE_ZONE_RESERVATION_METHOD = 'host.nativeZone.reserve';
const HOST_REQUEST_TIMEOUT_MS = 5_000;

interface HostReservationRequest {
  type: 'request';
  id: string;
  method: typeof HOST_NATIVE_ZONE_RESERVATION_METHOD;
}

export interface HostReservationClientDependencies {
  send(request: HostReservationRequest): void;
  isLocalConnected(): boolean;
  timers: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'>;
}

export interface HostZoneReservationClient extends ZoneFenceLock {
  /** Consumes only the exactly matched outstanding reservation response. */
  handleResponse(message: unknown): boolean;
  /** Rejects a pending request after socket close, replace or mode change. */
  reset(): void;
}

type Pending = {
  id: string;
  epoch: number;
  timer: RuntimeTimerHandle;
  resolve: (granted: boolean) => void;
};

function isPositiveHostReservationResponse(value: unknown, id: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (response.type !== 'response' || response.id !== id || response.ok !== true) return false;
  const result = response.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  const grant = result as Record<string, unknown>;
  return (
    grant.granted === true &&
    grant.authorizesMutation === false &&
    grant.independentRecoveryRequired === true
  );
}

export function createHostZoneReservationClient(
  dependencies: HostReservationClientDependencies,
  timeoutMs = HOST_REQUEST_TIMEOUT_MS,
): HostZoneReservationClient {
  let epoch = 0;
  let sequence = 0;
  let attempted = false;
  let pending: Pending | undefined;

  function settle(granted: boolean): void {
    if (!pending) return;
    const request = pending;
    pending = undefined;
    dependencies.timers.clearTimeout(request.timer);
    request.resolve(granted && request.epoch === epoch);
  }

  function reset(): void {
    epoch += 1;
    settle(false);
    // Once issued, a host reservation might have succeeded even if the
    // response was never delivered; do not silently retry on a new socket.
  }

  function handleResponse(message: unknown): boolean {
    if (!pending || typeof message !== 'object' || message === null) return false;
    const response = message as Record<string, unknown>;
    if (response.type !== 'response' || response.id !== pending.id) return false;
    settle(isPositiveHostReservationResponse(message, pending.id));
    return true;
  }

  async function exclusive(action: () => Promise<boolean>): Promise<boolean> {
    if (attempted || pending || !dependencies.isLocalConnected() || typeof action !== 'function')
      return false;
    attempted = true;
    const requestEpoch = epoch;
    const id = 'host_zone_' + ++sequence;
    let granted: boolean;

    try {
      granted = await new Promise<boolean>((resolve) => {
        const timer = dependencies.timers.setTimeout(() => {
          settle(false);
        }, timeoutMs);
        pending = { id, epoch: requestEpoch, timer, resolve };
        dependencies.send({ id, type: 'request', method: HOST_NATIVE_ZONE_RESERVATION_METHOD });
      });
    } catch {
      settle(false);
      return false;
    }
    if (!granted || requestEpoch !== epoch || !dependencies.isLocalConnected()) return false;
    try {
      const actionResult = await action();
      return actionResult === true && requestEpoch === epoch && dependencies.isLocalConnected();
    } catch {
      // The host lock remains held and the native fence requires independent
      // recovery. Never classify a failed/unknown action as safe to retry.
      return false;
    }
  }

  return { exclusive, handleResponse, reset };
}
