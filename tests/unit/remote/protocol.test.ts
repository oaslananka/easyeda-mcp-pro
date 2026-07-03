import { describe, expect, it } from 'vitest';
import {
  RegisterSessionMessageSchema,
  RelayMessageSchema,
  REMOTE_RELAY_PROTOCOL_VERSION,
  ToolRequestMessageSchema,
} from '../../../src/remote/protocol.js';

describe('remote relay protocol', () => {
  it('validates extension session registration', () => {
    const parsed = RegisterSessionMessageSchema.parse({
      protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
      messageId: 'msg_1',
      timestamp: '2026-07-03T00:00:00.000Z',
      type: 'register_session',
      extensionVersion: '0.17.1',
      mode: 'hosted',
      activeProject: { projectName: 'Power Board', documentType: 'schematic' },
      capabilities: ['schematic.read'],
    });

    expect(parsed.type).toBe('register_session');
    expect(parsed.activeProject?.projectName).toBe('Power Board');
  });

  it('rejects local mode for remote registration', () => {
    expect(() =>
      RegisterSessionMessageSchema.parse({
        protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
        messageId: 'msg_1',
        timestamp: '2026-07-03T00:00:00.000Z',
        type: 'register_session',
        extensionVersion: '0.17.1',
        mode: 'local',
      }),
    ).toThrow();
  });

  it('validates tool request envelope', () => {
    const parsed = ToolRequestMessageSchema.parse({
      protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
      messageId: 'msg_2',
      sessionId: 'sess_1',
      timestamp: '2026-07-03T00:00:01.000Z',
      type: 'tool_request',
      toolName: 'schematic.listComponents',
      riskLevel: 'read',
      requiresApproval: false,
      inputHash: 'sha256:abc',
    });

    expect(parsed.riskLevel).toBe('read');
  });

  it('parses discriminated relay messages', () => {
    const parsed = RelayMessageSchema.parse({
      protocolVersion: REMOTE_RELAY_PROTOCOL_VERSION,
      messageId: 'msg_3',
      timestamp: '2026-07-03T00:00:02.000Z',
      type: 'heartbeat',
    });

    expect(parsed.type).toBe('heartbeat');
  });
});
