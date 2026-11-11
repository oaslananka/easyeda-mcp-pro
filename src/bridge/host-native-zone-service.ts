import {
  NativeZoneHostWriterCoordinator,
  type NativeZoneHostLease,
} from './native-zone-host-writer.js';

type ReservationResponse =
  | {
      ok: true;
      result: {
        granted: boolean;
        independentRecoveryRequired: true;
        authorizesMutation: false;
      };
    }
  | {
      ok: false;
      error: {
        code: 'INVALID_PARAMS' | 'BRIDGE_NOT_READY';
        message: string;
        suggestion: string;
      };
    };

const denied = (
  code: 'INVALID_PARAMS' | 'BRIDGE_NOT_READY',
  message: string,
): ReservationResponse => ({
  ok: false,
  error: {
    code,
    message,
    suggestion: 'Reopen a current local Bridge session; never bypass native write recovery.',
  },
});

const result = (granted: boolean): ReservationResponse => ({
  ok: true,
  result: {
    granted,
    independentRecoveryRequired: true,
    authorizesMutation: false,
  },
});

function invalidParams(params: unknown): boolean {
  return (
    params !== undefined &&
    (typeof params !== 'object' ||
      params === null ||
      Array.isArray(params) ||
      Object.keys(params).length > 0)
  );
}

/**
 * Only an active, version- and registry-matched local editor socket may
 * request a reservation. This is NOT proof of confirmed mutation approval
 * and does not connect the disabled native-zone candidate to public MCP tools.
 */
export class HostNativeZoneReservationService {
  private lease: NativeZoneHostLease | undefined;

  constructor(private readonly coordinator = new NativeZoneHostWriterCoordinator()) {}

  async reserve(params: unknown, trustedSession: boolean): Promise<ReservationResponse> {
    if (invalidParams(params))
      return denied('INVALID_PARAMS', 'Host native zone reservation takes no client parameters.');
    if (!trustedSession)
      return denied(
        'BRIDGE_NOT_READY',
        'Only an active exact-version local Bridge session may request a host reservation.',
      );

    // Reentrant requests are blocked even when they originate from the same
    // Bridge PID; a pending write is not cleared by a disconnect or timeout.
    if (this.lease) return result(false);
    try {
      const lease = await this.coordinator.tryAcquire();
      if (!lease) return result(false);
      this.lease = lease;
      return result(true);
    } catch {
      return denied('BRIDGE_NOT_READY', 'Host writer reservation could not be safely established.');
    }
  }
}
