import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { EasyedaApiMethodSchema } from './types.js';
import { type BridgeHello } from './protocol.js';

export const LOCAL_BRIDGE_RELAY_PROTOCOL_VERSION = 1 as const;
const DEFAULT_RELAY_AUTH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RELAY_CLIENTS = 32;

export type SharedBridgeState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SharedBridgeSnapshot {
  state: SharedBridgeState;
  hello: BridgeHello | null;
  activePort: number;
  connectedAtMs: number;
  lastHeartbeatMs: number;
  extensionVersion?: string;
  extensionMethodListHash?: string;
  loaderVersion?: string;
}

export interface LocalBridgeRelayEndpoint {
  host: '127.0.0.1';
  port: number;
  token: string;
}

interface RelayCallOptions {
  timeoutMs?: number;
  traceparent?: string;
}

interface RelayServerOptions {
  token: string;
  maxPayloadBytes: number;
  snapshot: () => SharedBridgeSnapshot;
  call: (method: string, params: unknown, options: RelayCallOptions) => Promise<unknown>;
  authTimeoutMs?: number;
  maxClients?: number;
}

interface RelayErrorPayload {
  code?: string;
  message: string;
  suggestion?: string;
  data?: unknown;
}

interface PendingRelayRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorPayload(error: unknown): RelayErrorPayload {
  const record = isRecord(error) ? error : {};
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: error instanceof Error ? error.message : String(error),
    suggestion: typeof record.suggestion === 'string' ? record.suggestion : undefined,
    data: record.data,
  };
}

function errorFromPayload(payload: RelayErrorPayload): Error {
  const error = new Error(payload.message);
  Object.assign(error, {
    code: payload.code,
    suggestion: payload.suggestion,
    data: payload.data,
  });
  return error;
}

export class LocalBridgeRelayServer {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly options: RelayServerOptions) {}

  async start(): Promise<number> {
    if (this.wss) throw new Error('Local bridge follower relay is already running.');

    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: this.options.maxPayloadBytes,
    });
    this.wss = wss;
    wss.on('connection', (socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        wss.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        wss.off('error', onError);
        resolve();
      };
      wss.once('error', onError);
      wss.once('listening', onListening);
    });

    const address = wss.address();
    if (!address || typeof address === 'string') {
      wss.close();
      this.wss = null;
      throw new Error('Local bridge follower relay did not expose a TCP port.');
    }
    return address.port;
  }

  broadcast(snapshot = this.options.snapshot()): void {
    const payload = JSON.stringify({
      type: 'status',
      protocolVersion: LOCAL_BRIDGE_RELAY_PROTOCOL_VERSION,
      snapshot,
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  close(): void {
    const wss = this.wss;
    this.wss = null;
    for (const client of this.clients) {
      client.close(1001, 'owner_shutdown');
    }
    this.clients.clear();
    wss?.close();
  }

  private handleConnection(socket: WebSocket): void {
    const maxClients = this.options.maxClients ?? DEFAULT_MAX_RELAY_CLIENTS;
    if ((this.wss?.clients.size ?? 0) > maxClients) {
      socket.close(1013, 'relay_capacity');
      return;
    }

    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated && socket.readyState === WebSocket.OPEN) {
        socket.close(4003, 'relay_auth_timeout');
      }
    }, this.options.authTimeoutMs ?? DEFAULT_RELAY_AUTH_TIMEOUT_MS);

    socket.on('message', (raw) => {
      let data: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!isRecord(parsed)) throw new Error('relay message must be an object');
        data = parsed;
      } catch {
        socket.close(4001, 'invalid_message');
        return;
      }

      if (!authenticated) {
        if (
          data.type !== 'attach' ||
          data.protocolVersion !== LOCAL_BRIDGE_RELAY_PROTOCOL_VERSION ||
          data.token !== this.options.token
        ) {
          socket.close(4003, 'invalid_relay_auth');
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        this.clients.add(socket);
        socket.send(
          JSON.stringify({
            type: 'attached',
            protocolVersion: LOCAL_BRIDGE_RELAY_PROTOCOL_VERSION,
            snapshot: this.options.snapshot(),
          }),
        );
        return;
      }

      if (data.type !== 'call' || typeof data.id !== 'string' || typeof data.method !== 'string') {
        socket.close(4001, 'invalid_relay_message');
        return;
      }
      if (!(EasyedaApiMethodSchema.options as readonly string[]).includes(data.method)) {
        socket.send(
          JSON.stringify({
            type: 'response',
            id: data.id,
            ok: false,
            error: {
              code: 'METHOD_NOT_FOUND',
              message: `Unknown bridge method: "${data.method}"`,
            },
          }),
        );
        return;
      }

      const timeoutMs =
        typeof data.timeoutMs === 'number' && Number.isFinite(data.timeoutMs) && data.timeoutMs > 0
          ? data.timeoutMs
          : undefined;
      const traceparent = typeof data.traceparent === 'string' ? data.traceparent : undefined;
      void this.options
        .call(data.method, data.params, { timeoutMs, traceparent })
        .then((result) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ type: 'response', id: data.id, ok: true, result }));
        })
        .catch((error: unknown) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(
            JSON.stringify({
              type: 'response',
              id: data.id,
              ok: false,
              error: errorPayload(error),
            }),
          );
        });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(socket);
    });
  }
}

export class LocalBridgeRelayClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private attached = false;
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRelayRequest>();

  constructor(private readonly endpoint: LocalBridgeRelayEndpoint) {
    super();
  }

  async connect(timeoutMs = 1_500): Promise<SharedBridgeSnapshot> {
    if (this.socket) throw new Error('Local bridge follower relay is already connected.');
    const socket = new WebSocket(`ws://${this.endpoint.host}:${this.endpoint.port}`);
    this.socket = socket;

    return new Promise<SharedBridgeSnapshot>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close(4000, 'attach_timeout');
        this.socket = null;
        reject(new Error('Timed out attaching to the local EasyEDA bridge owner.'));
      }, timeoutMs);

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = null;
        reject(error);
      };

      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'attach',
            protocolVersion: LOCAL_BRIDGE_RELAY_PROTOCOL_VERSION,
            token: this.endpoint.token,
          }),
        );
      });
      socket.once('error', (error) => fail(error));
      socket.on('message', (raw) => {
        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw.toString()) as unknown;
          if (!isRecord(parsed)) return;
          message = parsed;
        } catch {
          return;
        }

        if (!this.attached && message.type === 'attached' && isRecord(message.snapshot)) {
          this.attached = true;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(message.snapshot as unknown as SharedBridgeSnapshot);
          }
          return;
        }
        if (message.type === 'status' && isRecord(message.snapshot)) {
          this.emit('status', message.snapshot as unknown as SharedBridgeSnapshot);
          return;
        }
        if (message.type !== 'response' || typeof message.id !== 'string') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok === true) {
          pending.resolve(message.result);
        } else {
          const payload = isRecord(message.error)
            ? (message.error as unknown as RelayErrorPayload)
            : { message: 'Shared EasyEDA bridge call failed.' };
          pending.reject(errorFromPayload(payload));
        }
      });
      socket.on('close', (code, reason) => {
        clearTimeout(timer);
        this.socket = null;
        this.attached = false;
        const error = new Error(
          `Local EasyEDA bridge owner relay disconnected (${code}: ${reason.toString() || 'closed'}).`,
        );
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        if (!settled) fail(error);
        else this.emit('close', error);
      });
    });
  }

  call<TResult>(
    method: string,
    params: unknown,
    options: RelayCallOptions,
    responseTimeoutMs: number,
  ): Promise<TResult> {
    const socket = this.socket;
    if (!socket || !this.attached || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Local EasyEDA bridge owner relay is not connected.'));
    }

    const id = `relay_${process.pid}_${++this.requestCounter}`;
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Shared bridge method "${method}" timed out after ${responseTimeoutMs}ms`),
        );
      }, responseTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.send(
        JSON.stringify({
          type: 'call',
          id,
          method,
          params,
          timeoutMs: options.timeoutMs,
          traceparent: options.traceparent,
        }),
      );
    });
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.attached = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Local EasyEDA bridge follower disconnected.'));
    }
    this.pending.clear();
    socket?.close(1000, 'follower_shutdown');
  }
}
