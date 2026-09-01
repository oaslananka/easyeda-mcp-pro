export interface LocalBridgeConnectionAttempt {
  port: number;
  timeoutMs: number;
}

export const BRIDGE_PORT = 49_620;
export const PORT_SCAN_COUNT = 10;
export const PRIMARY_CONNECT_TIMEOUT_MS = 8_000;
export const FALLBACK_CONNECT_TIMEOUT_MS = 1_000;
export const REGISTER_OPEN_CALLBACK_TIMEOUT_MS = 600;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_LIVENESS_MULTIPLIER = 3;
export const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_LIVENESS_MULTIPLIER;

const LOCAL_BRIDGE_HOST = '127.0.0.1';

/**
 * Build the only cleartext WebSocket endpoint the extension may use locally.
 * The bridge does not terminate TLS, so `ws:` is intentionally restricted to
 * the fixed OS-loopback host and the bounded bridge scan range. Remote relay
 * connections use `wss:` through RemoteRelayClient instead.
 */
export function buildLocalBridgeWebSocketUrl(port: number): string {
  const lastBridgePort = BRIDGE_PORT + PORT_SCAN_COUNT - 1;
  if (!Number.isSafeInteger(port) || port < BRIDGE_PORT || port > lastBridgePort) {
    throw new RangeError(`Invalid local bridge port: ${port}`);
  }

  const url = new URL(`http://${LOCAL_BRIDGE_HOST}:${port}/`);
  url.protocol = 'ws:';
  return `${url.protocol}//${url.host}`;
}

/**
 * Produce a deterministic local-port scan order that retries the last known
 * working port first, then covers the configured bridge range exactly once.
 *
 * EasyEDA's SYS_WebSocket.register path can defer its open callback and needs
 * several seconds of handshake grace on the preferred port. Secondary ports
 * stay short so a missing local server cannot block auto-connect for 80 seconds.
 */
export function getLocalBridgeConnectionAttempts(
  preferredPort = BRIDGE_PORT,
): LocalBridgeConnectionAttempt[] {
  const range = Array.from({ length: PORT_SCAN_COUNT }, (_, offset) => BRIDGE_PORT + offset);
  const ordered = range.includes(preferredPort)
    ? [preferredPort, ...range.filter((port) => port !== preferredPort)]
    : range;

  return ordered.map((port, index) => ({
    port,
    timeoutMs: index === 0 ? PRIMARY_CONNECT_TIMEOUT_MS : FALLBACK_CONNECT_TIMEOUT_MS,
  }));
}

export function reconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(RECONNECT_BASE_MS * 2 ** (safeAttempt - 1), RECONNECT_MAX_MS);
}

export interface SocketFailureReconnectInput {
  wasConnected: boolean;
  manualDisconnectRequested: boolean;
  autoConnectEnabled: boolean;
}

export function shouldReconnectAfterSocketFailure({
  wasConnected,
  manualDisconnectRequested,
  autoConnectEnabled,
}: SocketFailureReconnectInput): boolean {
  return wasConnected && autoConnectEnabled && !manualDisconnectRequested;
}

export function hasHeartbeatTimedOut(
  lastServerActivityMs: number,
  nowMs: number,
  timeoutMs = HEARTBEAT_TIMEOUT_MS,
): boolean {
  if (!Number.isFinite(lastServerActivityMs) || lastServerActivityMs <= 0) return false;
  if (!Number.isFinite(nowMs) || nowMs < lastServerActivityMs) return false;
  return nowMs - lastServerActivityMs > timeoutMs;
}

export type HeartbeatSource = 'server' | 'extension' | undefined;

/**
 * EasyEDA SYS_WebSocket may reflect an outbound frame back through the local
 * message callback. An extension-originated heartbeat is therefore not proof
 * that the server is alive. All non-heartbeat messages and server/legacy
 * heartbeats remain valid server activity.
 */
export function isServerActivityMessage(
  messageType: string | undefined,
  heartbeatSource: HeartbeatSource,
): boolean {
  return messageType !== 'heartbeat' || heartbeatSource !== 'extension';
}
