import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { type EnvConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import {
  type BridgeHello,
  type BridgeResponse,
  BRIDGE_CONTRACT_VERSION,
  BridgeHandshakeSchema,
  BridgePairingResponseSchema,
  BridgeRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './protocol.js';
import { EasyedaApiMethodSchema } from './types.js';
import { SERVER_VERSION } from '../config/version.js';
import { getGlobalMetricsCollector } from '../observability/index.js';

const PAIRING_TIMEOUT_MS = 10_000;
const STALE_SWEEP_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Zombie detection: if no heartbeat received within 3× the heartbeat interval, close the socket.
const HEARTBEAT_LIVENESS_MULTIPLIER = 3;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  startedAt: number;
}

interface PairingEntry {
  challenge: string;
  timer: ReturnType<typeof setTimeout>;
}

export type BridgeState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class BridgeManager extends EventEmitter {
  public state: BridgeState = 'disconnected';
  public hello: BridgeHello | null = null;

  private wss: WebSocketServer | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private _activePort = 0;
  private _connectedAtMs = 0;
  private requestMap = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private config: EnvConfig;
  private _lastHeartbeatMs = 0;
  private reconnectAttempts = 0;
  private reconnectStartMs = 0;
  private pairingChallenges = new Map<string, PairingEntry>();
  private _methodRegistryHash: string;

  constructor(config: EnvConfig) {
    super();
    this.config = config;
    this._methodRegistryHash = this.computeMethodRegistryHash();
  }

  get lastHeartbeatMs(): number {
    return this._lastHeartbeatMs;
  }

  get activePort(): number {
    return this._activePort;
  }

  get uptimeMs(): number {
    if (this.state !== 'connected' || this._connectedAtMs === 0) return 0;
    return Date.now() - this._connectedAtMs;
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Wait until the bridge is in the 'connected' state.
   * Resolves immediately if already connected. Rejects after timeoutMs.
   */
  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new Error('Bridge not connected'));
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('connected', onConnected);
    });
  }

  get methodRegistryHash(): string {
    return this._methodRegistryHash;
  }

  private isLoopbackHost(host: string): boolean {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }

  private computeMethodRegistryHash(): string {
    const sorted = [...EasyedaApiMethodSchema.options].sort();
    return crypto.createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 16);
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;

    const prev = this.state;
    this.state = 'connecting';
    this.emit('stateChanged', this.state, prev);

    const logger = getLogger();

    const ports = parsePortScanSpec(this.config.BRIDGE_PORT_SCAN);
    let lastErr: Error | null = null;

    for (const port of ports) {
      try {
        await this.tryListen(port);
        logger.info({ port }, 'bridge websocket server listening');
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        logger.debug({ port, err: lastErr.message }, 'bridge port unavailable, trying next');
      }
    }

    logger.error({ ports, err: lastErr?.message }, 'failed to start bridge server on any port');
    this.state = 'error';
    this.emit('stateChanged', 'error', 'connecting');
    this.emit('error', lastErr ?? new Error('No available bridge port'));
    throw lastErr ?? new Error('No available bridge port');
  }

  private tryListen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.config.BRIDGE_HOST,
        port,
      });
      this.wss = wss;
      this._activePort = port;

      wss.once('listening', () => {
        wss.on('error', (err) => {
          getLogger().error({ err }, 'bridge server error');
          this.emit('error', err);
        });
        resolve();
      });
      wss.once('error', (err) => {
        this.wss = null;
        this._activePort = 0;
        reject(err);
      });

      wss.on('connection', (ws) => this.handleConnection(ws));
    });
  }

  private handleConnection(ws: WebSocket): void {
    const logger = getLogger();
    const isLoopback = this.isLoopbackHost(this.config.BRIDGE_HOST);
    const needsPairing = !isLoopback && !!this.config.BRIDGE_TOKEN;
    let paired = !needsPairing;
    let pairingChallengeId: string | null = null;

    logger.info({ needsPairing, isLoopback }, 'new bridge client connection');

    // Issue pairing challenge for non-loopback connections with a token configured
    if (needsPairing) {
      const challenge = crypto.randomUUID();
      pairingChallengeId = challenge;
      const timer = setTimeout(() => {
        if (this.pairingChallenges.has(challenge)) {
          this.pairingChallenges.delete(challenge);
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(4001, 'pairing_timeout');
          }
        }
      }, PAIRING_TIMEOUT_MS);
      this.pairingChallenges.set(challenge, { challenge, timer });
      ws.send(JSON.stringify({ type: 'pairing_challenge', challenge }));
      logger.info('sent pairing challenge to new client');
    }

    ws.on('message', (raw) => {
      try {
        // 0. Payload size enforcement (before parsing)
        const rawSize = Array.isArray(raw)
          ? raw.reduce((sum, chunk) => sum + chunk.byteLength, 0)
          : raw.byteLength;
        if (rawSize > this.config.BRIDGE_MAX_PAYLOAD_SIZE) {
          logger.warn({ size: rawSize }, 'payload exceeds maximum size');
          ws.close(4009, 'payload_too_large');
          return;
        }

        const data = JSON.parse(raw.toString());

        // 1. Handle pairing response (if challenge was issued)
        if (!paired && pairingChallengeId && data.type === 'pairing_response') {
          const parsed = BridgePairingResponseSchema.safeParse(data);
          if (
            !parsed.success ||
            parsed.data.challenge !== pairingChallengeId ||
            parsed.data.sessionToken !== this.config.BRIDGE_TOKEN
          ) {
            logger.warn('pairing response validation failed');
            ws.close(4001, 'invalid_pairing');
            return;
          }
          // Pairing successful — clean up challenge and allow handshake
          const entry = this.pairingChallenges.get(pairingChallengeId);
          if (entry) {
            clearTimeout(entry.timer);
            this.pairingChallenges.delete(pairingChallengeId);
          }
          paired = true;
          logger.info('client pairing successful');
          return; // Wait for the next message (handshake)
        }

        // 2. Reject if pairing is required but not yet completed
        if (needsPairing && !paired) {
          ws.close(4001, 'pairing_required');
          return;
        }

        // 3. Normal message routing
        if (data.type === 'handshake') {
          this.handleHandshake(ws, data);
        } else if (data.type === 'response') {
          this.handleResponse(data);
        } else if (data.type === 'request') {
          this.handleIncomingRequest(ws, data);
        } else if (data.type === 'heartbeat') {
          this._lastHeartbeatMs = Date.now();
          this.emit('heartbeat', data.timestamp);
        }
      } catch (err) {
        logger.error({ err }, 'bridge message processing error');
      }
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) {
        logger.debug({ code, reason: reason.toString() }, 'stale bridge client disconnected');
        return;
      }

      logger.info({ code, reason: reason.toString() }, 'bridge client disconnected');
      this.ws = null;
      const prevState = this.state;
      this.state = 'connecting';
      this._connectedAtMs = 0;
      this.hello = null;
      this.stopStaleSweep();
      this.stopHeartbeat();

      // Clean up any pending pairing challenges
      for (const [, entry] of this.pairingChallenges) {
        clearTimeout(entry.timer);
      }
      this.pairingChallenges.clear();

      this.rejectPending(
        new Error(`Bridge disconnected: ${reason.toString() || 'connection closed'}`),
      );
      this.emit('stateChanged', this.state, prevState);
      this.emit('disconnected', reason.toString() || 'connection closed');
      this.scheduleReconnect();
      // The WSS is still listening; no reconnect needed — wait for the next client.
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'bridge client socket error');
    });
  }

  /**
   * Validate and accept a handshake message. Sets up the bridge session
   * and replies with a hello containing the server's capabilities.
   */
  private handleHandshake(ws: WebSocket, data: unknown): void {
    const logger = getLogger();
    const parsed = BridgeHandshakeSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.issues }, 'bridge handshake validation failed');
      ws.close(4001, 'Invalid handshake');
      return;
    }

    // Session token enforcement
    if (this.config.BRIDGE_TOKEN) {
      if (!parsed.data.sessionToken) {
        logger.warn('bridge handshake rejected: session token required');
        ws.close(4001, 'session_token_required');
        return;
      }
      if (parsed.data.sessionToken !== this.config.BRIDGE_TOKEN) {
        logger.warn('bridge handshake rejected: invalid session token');
        ws.close(4001, 'invalid_session_token');
        return;
      }
    }

    // Replace existing connection if any
    const previousWs = this.ws;
    const prevState = this.state;

    if (previousWs && previousWs !== ws) {
      logger.info('replacing existing bridge client connection');
      this.rejectPending(new Error('Bridge connection replaced by a new client.'));
      previousWs.close(4000, 'Replaced by new bridge client');
      this.stopHeartbeat();
      this.stopStaleSweep();
    }

    this.ws = ws;
    this.state = 'connected';
    this._connectedAtMs = Date.now();
    this._lastHeartbeatMs = Date.now(); // seed so first liveness check doesn't fire immediately
    this.reconnectAttempts = 0;
    this.reconnectStartMs = 0;

    // Extension version mismatch warning
    const extVer = parsed.data.extensionVersion;
    if (extVer && extVer !== SERVER_VERSION) {
      logger.warn(
        `⚠️ EasyEDA Pro bridge extension version mismatch: extension is v${extVer}, but MCP server is v${SERVER_VERSION}. Please update the extension in EasyEDA Pro.`,
      );
    }

    this.hello = {
      type: 'hello',
      bridgeVersion: SERVER_VERSION,
      contractVersion: BRIDGE_CONTRACT_VERSION,
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      easyedaVersion: parsed.data.easyedaVersion,
      capabilities: EasyedaApiMethodSchema.options,
      methodRegistryHash: this._methodRegistryHash,
      devMode: parsed.data.devMode ?? false,
    };

    // Reply with hello
    ws.send(JSON.stringify(this.hello));
    if (prevState !== 'connected') {
      this.emit('stateChanged', 'connected', prevState);
    }
    this.emit('connected', this.hello);
    this.startHeartbeat();
    this.startStaleSweep();
  }

  /**
   * Validate and handle an incoming request from the extension.
   * The server does not currently accept arbitrary extension requests,
   * so unknown methods are rejected with a structured error response.
   */
  private handleIncomingRequest(ws: WebSocket, data: unknown): void {
    const logger = getLogger();
    const parsed = BridgeRequestSchema.safeParse(data);
    if (!parsed.success) {
      const fallbackId = (data as Record<string, unknown>)?.id ?? 'unknown';
      logger.warn({ id: fallbackId }, 'incoming request validation failed');
      ws.send(
        JSON.stringify({
          id: String(fallbackId),
          type: 'response',
          ok: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'Invalid request schema',
            suggestion: 'Check the request format and required fields.',
          },
          durationMs: 0,
        }),
      );
      return;
    }

    // Reject unknown methods
    if (!(EasyedaApiMethodSchema.options as readonly string[]).includes(parsed.data.method)) {
      logger.warn({ method: parsed.data.method }, 'unknown bridge method requested');
      ws.send(
        JSON.stringify({
          id: parsed.data.id,
          type: 'response',
          ok: false,
          error: {
            code: 'METHOD_NOT_FOUND',
            message: `Unknown bridge method: "${parsed.data.method}"`,
            suggestion: `Use one of the supported methods: ${EasyedaApiMethodSchema.options.slice(0, 5).join(', ')}…`,
          },
          durationMs: 0,
        }),
      );
      return;
    }

    // Known method, but the server does not handle incoming extension requests directly.
    // This path is reserved for future use (e.g., event notifications from the extension).
    logger.warn({ method: parsed.data.method }, 'incoming request not supported');
    ws.send(
      JSON.stringify({
        id: parsed.data.id,
        type: 'response',
        ok: false,
        error: {
          code: 'BRIDGE_NOT_READY',
          message: 'Incoming extension requests are not supported yet.',
          suggestion: 'Use the MCP tool API to invoke this method.',
        },
        durationMs: 0,
      }),
    );
  }

  async call<TParams, TResult>(
    method: string,
    params?: TParams,
    opts?: { timeoutMs?: number; traceparent?: string },
  ): Promise<TResult> {
    if (this.state !== 'connected') {
      const waitMs = this.config.BRIDGE_WAIT_FOR_EDA_MS;
      if (waitMs > 0) {
        await this.waitForConnection(waitMs);
      }
    }

    const ws = this.ws;
    if (this.state !== 'connected' || !ws) {
      throw new Error(`Bridge not connected. Cannot call method "${method}".`);
    }

    const id = `req_${++this.requestIdCounter}`;
    const timeoutMs = opts?.timeoutMs ?? this.config.BRIDGE_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requestMap.delete(id);
        getGlobalMetricsCollector().recordTimed({
          category:
            method.startsWith('export.') || method.startsWith('board.export')
              ? 'export'
              : 'bridge-read',
          name: method,
          durationMs: timeoutMs,
          ok: false,
        });
        reject(new Error(`Bridge method "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.requestMap.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
        startedAt: Date.now(),
      });

      const message = JSON.stringify({
        id,
        type: 'request',
        method,
        params,
        timeoutMs,
        traceparent: opts?.traceparent,
      });

      ws.send(message);
    }) as Promise<TResult>;
  }

  disconnect(reason?: string): void {
    const prev = this.state;
    this.state = 'disconnected';

    this.stopHeartbeat();
    this.stopStaleSweep();
    this.clearReconnectTimer();

    // Clean up pending pairing challenges
    for (const [, entry] of this.pairingChallenges) {
      clearTimeout(entry.timer);
    }
    this.pairingChallenges.clear();

    this.rejectPending(new Error(`Bridge disconnected: ${reason ?? 'unknown'}`));

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.hello = null;
    this.reconnectAttempts = 0;
    this.emit('stateChanged', this.state, prev);
    this.emit('disconnected', reason ?? 'unknown');
  }

  private handleResponse(data: BridgeResponse): void {
    const entry = this.requestMap.get(data.id);
    if (!entry) {
      getLogger().warn({ requestId: data.id }, 'received response for unknown request');
      return;
    }

    clearTimeout(entry.timer);
    this.requestMap.delete(data.id);
    const durationMs = Date.now() - entry.startedAt;
    getGlobalMetricsCollector().recordTimed({
      category:
        entry.method.startsWith('export.') || entry.method.startsWith('board.export')
          ? 'export'
          : 'bridge-read',
      name: entry.method,
      durationMs,
      ok: data.ok,
    });

    if (data.ok) {
      entry.resolve(data.result);
    } else {
      const error = new Error(data.error?.message ?? `Bridge method "${entry.method}" failed`);
      entry.reject(error);
    }
  }

  private rejectPending(error: Error): void {
    for (const [, entry] of this.requestMap) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.requestMap.clear();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.state !== 'connected') return;

      // Zombie detection: close if no heartbeat received within 3x the interval.
      const silenceMs = Date.now() - this._lastHeartbeatMs;
      const timeoutMs = this.config.BRIDGE_HEARTBEAT_MS * HEARTBEAT_LIVENESS_MULTIPLIER;
      if (silenceMs > timeoutMs) {
        getLogger().warn(
          { silenceMs, timeoutMs },
          'bridge heartbeat timeout — zombie connection detected, closing',
        );
        this.ws.close(4002, 'heartbeat_timeout');
        return;
      }

      try {
        this.ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
      } catch {
        getLogger().warn('bridge heartbeat send failed, disconnecting');
        this.disconnect('heartbeat failed');
      }
    }, this.config.BRIDGE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Schedule a reconnect attempt with tiered backoff. Never stops retrying.
   * Tiers (elapsed since first disconnect):
   *   0–30 s  → 1 s interval
   *   30–120 s → 3 s interval
   *   >120 s  → 10 s interval
   * Each delay has ±10 % jitter.
   */
  private scheduleReconnect(): void {
    if (this.state === 'disconnected') return;

    if (this.reconnectAttempts === 0) {
      this.reconnectStartMs = Date.now();
    }
    this.reconnectAttempts++;

    const elapsed = Date.now() - this.reconnectStartMs;
    let base: number;
    if (elapsed < 30_000) base = RECONNECT_BASE_MS;
    else if (elapsed < 120_000) base = RECONNECT_BASE_MS * 3;
    else base = Math.min(RECONNECT_BASE_MS * 10, RECONNECT_MAX_DELAY_MS);

    const jitter = base * 0.1 * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);

    getLogger().info(
      { attempt: this.reconnectAttempts, delay, elapsed },
      'scheduling bridge reconnect',
    );
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        getLogger().error({ err }, 'bridge reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Periodically sweep the pending-request map for entries whose
   * timeout has elapsed but whose `setTimeout` may have been leaked
   * (defence-in-depth). Runs every 30 s while connected.
   */
  private startStaleSweep(): void {
    if (this.staleSweepTimer) clearInterval(this.staleSweepTimer);
    this.staleSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.requestMap) {
        const elapsed = now - entry.startedAt;
        if (elapsed >= this.config.BRIDGE_TIMEOUT_MS) {
          getLogger().warn(
            { requestId: id, method: entry.method, elapsed },
            'stale sweep cleaning up expired request',
          );
          clearTimeout(entry.timer);
          entry.reject(new Error(`Bridge request "${entry.method}" expired (stale sweep)`));
          this.requestMap.delete(id);
        }
      }
    }, STALE_SWEEP_MS);
  }

  private stopStaleSweep(): void {
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
  }
}

/**
 * Parse a port scan specification string into an ordered array of ports.
 * Supports comma-separated values and dash ranges:
 *   "18601"           → [18601]
 *   "18601,49620"     → [18601, 49620]
 *   "49620-49629"     → [49620, 49621, ..., 49629]
 *   "18601,49620-49629" → [18601, 49620, 49621, ..., 49629]
 */
export function parsePortScanSpec(spec: string): number[] {
  const ports: number[] = [];
  const parts = spec.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch && rangeMatch[1] !== undefined && rangeMatch[2] !== undefined) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > 0 && end > 0 && start <= end && end <= 65535) {
        for (let p = start; p <= end; p++) {
          ports.push(p);
        }
      }
    } else {
      const port = parseInt(trimmed, 10);
      if (port > 0 && port <= 65535) {
        ports.push(port);
      }
    }
  }

  return ports;
}
