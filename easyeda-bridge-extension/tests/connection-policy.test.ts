import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PORT,
  FALLBACK_CONNECT_TIMEOUT_MS,
  getLocalBridgeConnectionAttempts,
  hasHeartbeatTimedOut,
  HEARTBEAT_TIMEOUT_MS,
  isServerActivityMessage,
  PRIMARY_CONNECT_TIMEOUT_MS,
  reconnectDelayMs,
  shouldReconnectAfterSocketFailure,
} from '../src/connection-policy.js';

describe('local bridge connection policy', () => {
  it('tries the preferred in-range port first and scans each bridge port once', () => {
    const attempts = getLocalBridgeConnectionAttempts(BRIDGE_PORT + 4);

    expect(attempts).toHaveLength(10);
    expect(attempts[0]).toEqual({
      port: BRIDGE_PORT + 4,
      timeoutMs: PRIMARY_CONNECT_TIMEOUT_MS,
    });
    expect(new Set(attempts.map(({ port }) => port)).size).toBe(10);
    expect(
      attempts.slice(1).every(({ timeoutMs }) => timeoutMs === FALLBACK_CONNECT_TIMEOUT_MS),
    ).toBe(true);
  });

  it('falls back to the standard range when the preferred port is outside it', () => {
    const attempts = getLocalBridgeConnectionAttempts(1234);
    expect(attempts[0]?.port).toBe(BRIDGE_PORT);
  });

  it('caps reconnect backoff at five seconds', () => {
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBe(1000);
    expect(reconnectDelayMs(20)).toBe(5000);
  });

  it('marks a silent established socket as stale after the heartbeat deadline', () => {
    expect(hasHeartbeatTimedOut(1_000, 1_000 + HEARTBEAT_TIMEOUT_MS)).toBe(false);
    expect(hasHeartbeatTimedOut(1_000, 1_001 + HEARTBEAT_TIMEOUT_MS)).toBe(true);
    expect(hasHeartbeatTimedOut(0, 100_000)).toBe(false);
  });

  it('reconnects only after an established auto-connected socket fails', () => {
    expect(
      shouldReconnectAfterSocketFailure({
        wasConnected: true,
        manualDisconnectRequested: false,
        autoConnectEnabled: true,
      }),
    ).toBe(true);
    expect(
      shouldReconnectAfterSocketFailure({
        wasConnected: false,
        manualDisconnectRequested: false,
        autoConnectEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldReconnectAfterSocketFailure({
        wasConnected: true,
        manualDisconnectRequested: true,
        autoConnectEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldReconnectAfterSocketFailure({
        wasConnected: true,
        manualDisconnectRequested: false,
        autoConnectEnabled: false,
      }),
    ).toBe(false);
  });

  it('does not treat an echoed extension heartbeat as server activity', () => {
    expect(isServerActivityMessage('heartbeat', 'extension')).toBe(false);
    expect(isServerActivityMessage('heartbeat', 'server')).toBe(true);
    expect(isServerActivityMessage('heartbeat', undefined)).toBe(true);
    expect(isServerActivityMessage('request', undefined)).toBe(true);
  });
});
