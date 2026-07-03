import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteRelayClient } from '../src/remote-client.js';

const PROTOCOL_VERSION = '2026-07-remote-relay-v1';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Test helper: simulate the socket completing its handshake. */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: simulate an inbound relay message. */
  simulateMessage(payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        messageId: `srv_${Math.random().toString(16).slice(2)}`,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    });
  }

  lastToolResponse(): Record<string, unknown> {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error('no message sent');
    return JSON.parse(raw) as Record<string, unknown>;
  }
}

function createConnectedClient(options: {
  executeToolRequest?: (toolName: string, input: unknown) => Promise<unknown>;
  isRemoteWriteApproved?: () => boolean;
}) {
  const client = new RemoteRelayClient({
    extensionVersion: '0.0.0-test',
    log: vi.fn(),
    showToast: vi.fn(),
    readActiveProject: () => ({ documentType: 'schematic' }),
    ...options,
  });
  client.connect({ mode: 'hosted' });
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.simulateOpen();
  return { client, socket };
}

describe('RemoteRelayClient tool_request dispatch', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects with REMOTE_EXECUTION_NOT_ENABLED when no executor is configured', () => {
    const { socket } = createConnectedClient({});
    socket.simulateMessage({ type: 'tool_request', toolName: 'schematic.listNets', input: {} });

    const response = socket.lastToolResponse();
    expect(response.ok).toBe(false);
    expect((response.error as { code: string }).code).toBe('REMOTE_EXECUTION_NOT_ENABLED');
  });

  it('rejects with REMOTE_TOOL_NAME_MISSING when toolName is absent', () => {
    const { socket } = createConnectedClient({ executeToolRequest: vi.fn() });
    socket.simulateMessage({ type: 'tool_request', input: {} });

    const response = socket.lastToolResponse();
    expect(response.ok).toBe(false);
    expect((response.error as { code: string }).code).toBe('REMOTE_TOOL_NAME_MISSING');
  });

  it('executes a read tool through the bridge and returns its result', async () => {
    const executeToolRequest = vi.fn().mockResolvedValue([{ netName: 'GND' }]);
    const { socket } = createConnectedClient({ executeToolRequest });
    socket.simulateMessage({
      type: 'tool_request',
      toolName: 'schematic.listNets',
      input: { projectId: 'p1' },
    });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    expect(executeToolRequest).toHaveBeenCalledWith('schematic.listNets', { projectId: 'p1' });
    const response = socket.lastToolResponse();
    expect(response.ok).toBe(true);
    expect(response.result).toEqual([{ netName: 'GND' }]);
  });

  it('fails closed on a destructive tool regardless of approval state', async () => {
    const executeToolRequest = vi.fn();
    const { socket } = createConnectedClient({
      executeToolRequest,
      isRemoteWriteApproved: () => true,
    });
    socket.simulateMessage({ type: 'tool_request', toolName: 'pcb.deleteComponent', input: {} });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    expect(executeToolRequest).not.toHaveBeenCalled();
    const response = socket.lastToolResponse();
    expect(response.ok).toBe(false);
    expect((response.error as { code: string }).code).toBe('REMOTE_DESTRUCTIVE_BLOCKED');
  });

  it('fails closed on api.* raw calls even if the envelope declares a low risk level', async () => {
    const executeToolRequest = vi.fn();
    const { socket } = createConnectedClient({
      executeToolRequest,
      isRemoteWriteApproved: () => true,
    });
    socket.simulateMessage({
      type: 'tool_request',
      toolName: 'api.call',
      riskLevel: 'read',
      input: {},
    });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    expect(executeToolRequest).not.toHaveBeenCalled();
    expect((socket.lastToolResponse().error as { code: string }).code).toBe(
      'REMOTE_DESTRUCTIVE_BLOCKED',
    );
  });

  it('requires approval before dispatching a write tool', async () => {
    const executeToolRequest = vi.fn().mockResolvedValue({ ok: true });
    const { socket } = createConnectedClient({
      executeToolRequest,
      isRemoteWriteApproved: () => false,
    });
    socket.simulateMessage({
      type: 'tool_request',
      toolName: 'schematic.placeComponent',
      input: {},
    });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    expect(executeToolRequest).not.toHaveBeenCalled();
    expect((socket.lastToolResponse().error as { code: string }).code).toBe(
      'REMOTE_APPROVAL_REQUIRED',
    );
  });

  it('dispatches a write tool once local approval is granted', async () => {
    const executeToolRequest = vi.fn().mockResolvedValue({ componentId: 'c1' });
    const { socket } = createConnectedClient({
      executeToolRequest,
      isRemoteWriteApproved: () => true,
    });
    socket.simulateMessage({
      type: 'tool_request',
      toolName: 'schematic.placeComponent',
      input: { x: 1, y: 2 },
    });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    expect(executeToolRequest).toHaveBeenCalledWith('schematic.placeComponent', { x: 1, y: 2 });
    const response = socket.lastToolResponse();
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ componentId: 'c1' });
  });

  it('requires approval before dispatching an export tool', async () => {
    const executeToolRequest = vi.fn();
    const { socket } = createConnectedClient({
      executeToolRequest,
      isRemoteWriteApproved: () => false,
    });
    socket.simulateMessage({ type: 'tool_request', toolName: 'export.pdf', input: {} });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    expect(executeToolRequest).not.toHaveBeenCalled();
    expect((socket.lastToolResponse().error as { code: string }).code).toBe(
      'REMOTE_APPROVAL_REQUIRED',
    );
  });

  it('surfaces a structured error when the bridge execution throws', async () => {
    const executeToolRequest = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Net "X" not found'), { code: 'NET_NOT_FOUND' }));
    const { socket } = createConnectedClient({ executeToolRequest });
    socket.simulateMessage({
      type: 'tool_request',
      toolName: 'schematic.getNetDetail',
      input: { netName: 'X' },
    });
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

    const response = socket.lastToolResponse();
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: 'NET_NOT_FOUND', message: 'Net "X" not found' });
  });
});
