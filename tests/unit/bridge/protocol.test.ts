import { describe, it, expect } from 'vitest';
import {
  BridgeHandshakeSchema,
  BridgeHelloSchema,
  BridgeRequestSchema,
  BridgeResponseSchema,
  BridgeHeartbeatSchema,
  BRIDGE_CONTRACT_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../../src/bridge/protocol.js';

describe('BridgeProtocol schemas', () => {
  describe('BridgeHandshakeSchema', () => {
    it('should validate a correct handshake', () => {
      const result = BridgeHandshakeSchema.parse({
        type: 'handshake',
        protocol: 'easyeda-mcp-pro.bridge',
        protocolVersion: '1.0.0',
        clientName: 'easyeda-mcp-pro',
        sessionToken: 'abc123',
      });
      expect(result.type).toBe('handshake');
      expect(result.contractVersion).toBe(BRIDGE_CONTRACT_VERSION);
    });

    it('should reject wrong protocol', () => {
      expect(() =>
        BridgeHandshakeSchema.parse({
          type: 'handshake',
          protocol: 'wrong-protocol',
          protocolVersion: '1.0.0',
          clientName: 'easyeda-mcp-pro',
        }),
      ).toThrow();
    });

    it('should reject unsupported protocol versions at schema boundary', () => {
      expect(() =>
        BridgeHandshakeSchema.parse({
          type: 'handshake',
          protocol: 'easyeda-mcp-pro.bridge',
          protocolVersion: '2.0.0',
          clientName: 'easyeda-mcp-pro',
        }),
      ).toThrow();
    });

    it('should allow optional session token', () => {
      const result = BridgeHandshakeSchema.parse({
        type: 'handshake',
        protocol: 'easyeda-mcp-pro.bridge',
        protocolVersion: '1.0.0',
        clientName: 'easyeda-mcp-pro',
      });
      expect(result.sessionToken).toBeUndefined();
    });
  });

  describe('BridgeHelloSchema', () => {
    it('should validate a correct hello', () => {
      const result = BridgeHelloSchema.parse({
        type: 'hello',
        bridgeVersion: '1.0.0',
        contractVersion: BRIDGE_CONTRACT_VERSION,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: ['schematic.read', 'pcb.read'],
        methodRegistryHash: 'abc123',
        devMode: false,
      });
      expect(result.bridgeVersion).toBe('1.0.0');
      expect(result.capabilities).toHaveLength(2);
    });

    it('should allow optional fields', () => {
      const result = BridgeHelloSchema.parse({
        type: 'hello',
        bridgeVersion: '1.0.0',
        contractVersion: BRIDGE_CONTRACT_VERSION,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: [],
        methodRegistryHash: 'abc',
        devMode: false,
      });
      expect(result.easyedaVersion).toBeUndefined();
      expect(result.maxPayloadSize).toBeUndefined();
    });

    it('should accept maxPayloadSize when present', () => {
      const result = BridgeHelloSchema.parse({
        type: 'hello',
        bridgeVersion: '1.0.0',
        contractVersion: BRIDGE_CONTRACT_VERSION,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: [],
        methodRegistryHash: 'abc',
        devMode: false,
        maxPayloadSize: 1_048_576,
      });
      expect(result.maxPayloadSize).toBe(1_048_576);
    });
  });

  describe('BridgeRequestSchema', () => {
    it('should validate a correct request', () => {
      const result = BridgeRequestSchema.parse({
        id: 'req_1',
        type: 'request',
        method: 'schematic.getBom',
        params: { project_id: 'proj_123' },
      });
      expect(result.method).toBe('schematic.getBom');
      expect(result.id).toBe('req_1');
    });

    it('should allow optional traceparent', () => {
      const result = BridgeRequestSchema.parse({
        id: 'req_2',
        type: 'request',
        method: 'test',
        traceparent: '00-abc-xyz-01',
      });
      expect(result.traceparent).toBe('00-abc-xyz-01');
    });
  });

  describe('BridgeResponseSchema', () => {
    it('should validate a successful response', () => {
      const result = BridgeResponseSchema.parse({
        id: 'req_1',
        type: 'response',
        ok: true,
        result: { components: [] },
        durationMs: 42,
      });
      expect(result.ok).toBe(true);
      expect(result.durationMs).toBe(42);
    });

    it('should validate an error response', () => {
      const result = BridgeResponseSchema.parse({
        id: 'req_1',
        type: 'response',
        ok: false,
        error: {
          code: 'METHOD_NOT_FOUND',
          message: 'Method not found',
          suggestion: 'Check method name',
        },
        durationMs: 10,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('METHOD_NOT_FOUND');
    });
  });

  describe('BridgeHeartbeatSchema', () => {
    it('should validate a heartbeat', () => {
      const result = BridgeHeartbeatSchema.parse({
        type: 'heartbeat',
        timestamp: 1234567890,
      });
      expect(result.type).toBe('heartbeat');
      expect(result.timestamp).toBe(1234567890);
    });
  });
});
