export type RemoteRelayMode = 'disabled' | 'hosted' | 'self_hosted';
export type RemoteRelayState = 'disconnected' | 'connecting' | 'connected' | 'paired';

export interface RemoteActiveProject {
  projectId?: string;
  projectName?: string;
  documentType: 'schematic' | 'pcb' | 'unknown';
  url?: string;
}

export interface RemoteRelayStatus {
  mode: RemoteRelayMode;
  state: RemoteRelayState;
  relayUrl?: string;
  sessionId?: string;
  pairingCode?: string;
  activeProject?: RemoteActiveProject;
  lastError?: string;
}

interface RemoteRelayClientOptions {
  extensionVersion: string;
  log: (message: string, data?: unknown) => void;
  showToast: (message: string) => void;
  readActiveProject: () => RemoteActiveProject | undefined;
}

interface RemoteEnvelope {
  protocolVersion: '2026-07-remote-relay-v1';
  messageId: string;
  type: string;
  sessionId?: string;
  timestamp: string;
  [key: string]: unknown;
}

const PROTOCOL_VERSION = '2026-07-remote-relay-v1';
const DEFAULT_HOSTED_RELAY_URL = 'wss://relay.easyeda-mcp-pro.local/session';

function makeMessageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export class RemoteRelayClient {
  private socket: WebSocket | null = null;
  private status: RemoteRelayStatus = { mode: 'disabled', state: 'disconnected' };

  constructor(private readonly options: RemoteRelayClientOptions) {}

  connect(input: {
    mode: Exclude<RemoteRelayMode, 'disabled'>;
    relayUrl?: string;
    pairingCode?: string;
  }): void {
    this.disconnect('replaced');
    const relayUrl = input.relayUrl ?? DEFAULT_HOSTED_RELAY_URL;
    this.status = {
      mode: input.mode,
      state: 'connecting',
      relayUrl,
      pairingCode: input.pairingCode,
      activeProject: this.options.readActiveProject(),
    };
    this.options.showToast(`Remote Relay connecting: ${input.mode}`);

    try {
      const socket = new WebSocket(relayUrl);
      this.socket = socket;
      socket.onopen = () => this.handleOpen(input.pairingCode);
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => this.handleError('Remote Relay socket error');
      socket.onclose = () => this.handleClose();
    } catch (error) {
      this.handleError(`Remote Relay failed to start: ${String(error)}`);
    }
  }

  disconnect(reason: 'user_disabled' | 'replaced' | 'disconnected' = 'user_disabled'): void {
    if (this.socket) {
      try {
        this.send({ type: 'session_closed', reason });
        this.socket.close();
      } catch (error) {
        this.options.log('Remote Relay close failed', error);
      }
    }
    this.socket = null;
    this.status = { ...this.status, state: 'disconnected', sessionId: undefined };
  }

  getStatus(): RemoteRelayStatus {
    return {
      ...this.status,
      activeProject: this.options.readActiveProject() ?? this.status.activeProject,
    };
  }

  private handleOpen(pairingCode?: string): void {
    this.status = { ...this.status, state: pairingCode ? 'paired' : 'connected' };
    this.send({
      type: 'register_session',
      extensionVersion: this.options.extensionVersion,
      mode: this.status.mode,
      pairingCode,
      activeProject: this.options.readActiveProject(),
      capabilities: ['local_bridge_proxy'],
    });
    this.options.showToast(
      pairingCode ? 'Remote Relay connected and pairing code sent' : 'Remote Relay connected',
    );
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : '';
    let message: RemoteEnvelope | undefined;
    try {
      message = JSON.parse(text) as RemoteEnvelope;
    } catch {
      this.options.log('Remote Relay ignored non-JSON message');
      return;
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.send({
        type: 'error',
        code: 'RELAY_VERSION_UNSUPPORTED',
        message: 'Unsupported relay protocol version',
      });
      return;
    }
    if (message.type === 'session_registered') {
      this.status = {
        ...this.status,
        state: message.paired ? 'paired' : 'connected',
        sessionId:
          typeof message.sessionId === 'string' ? message.sessionId : this.status.sessionId,
      };
      return;
    }
    if (message.type === 'heartbeat') {
      this.send({ type: 'heartbeat' });
      return;
    }
    if (message.type === 'approval_request') {
      this.options.showToast(
        `Remote approval requested: ${String(message.toolName ?? 'tool action')}`,
      );
      return;
    }
    if (message.type === 'tool_request') {
      this.send({
        type: 'tool_response',
        requestMessageId: message.messageId,
        ok: false,
        error: {
          code: 'REMOTE_EXECUTION_NOT_ENABLED',
          message: 'Remote command dispatch is not enabled in this extension build yet.',
          suggestion:
            'Use local bridge mode or wait for the next Remote Relay implementation phase.',
        },
        durationMs: 0,
      });
    }
  }

  private handleError(message: string): void {
    this.status = { ...this.status, state: 'disconnected', lastError: message };
    this.options.log(message);
    this.options.showToast(message);
  }

  private handleClose(): void {
    this.socket = null;
    if (this.status.state !== 'disconnected') {
      this.status = { ...this.status, state: 'disconnected' };
      this.options.showToast('Remote Relay disconnected');
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: makeMessageId(),
      sessionId: this.status.sessionId,
      timestamp: new Date().toISOString(),
      ...payload,
    } as RemoteEnvelope;
    this.socket.send(JSON.stringify(envelope));
  }
}
