import { describe, expect, it, vi } from 'vitest';
import { createBinaryResultNormalizer } from '../src/binary-result-policy.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

describe('binary result payload policy', () => {
  it('passes non-binary normalized results through without reading the transport budget', async () => {
    const getBridgeMaxPayloadSize = vi.fn(() => 1000);
    const normalizeResult = vi.fn(async () => ({ value: 'plain' }));
    const normalize = createBinaryResultNormalizer({
      getBridgeMaxPayloadSize,
      createBridgeError: bridgeError,
      normalizeResult,
    });

    await expect(normalize('input', 'fallback.txt')).resolves.toEqual({ value: 'plain' });
    expect(normalizeResult).toHaveBeenCalledWith('input', 'fallback.txt');
    expect(getBridgeMaxPayloadSize).not.toHaveBeenCalled();
  });

  it('accepts binary payloads at the floored safety budget', async () => {
    const payload = {
      base64: 'YQ==',
      mimeType: 'application/octet-stream',
      fileName: 'result.bin',
      byteLength: 600,
    };
    const normalize = createBinaryResultNormalizer({
      getBridgeMaxPayloadSize: () => 1001,
      createBridgeError: bridgeError,
      normalizeResult: async () => payload,
    });

    await expect(normalize('input', 'fallback.bin')).resolves.toBe(payload);
  });

  it('rejects payloads above the safe transport budget with the stable bridge error', async () => {
    const payload = {
      base64: 'YQ==',
      mimeType: 'application/zip',
      fileName: 'gerbers.zip',
      byteLength: 601,
    };
    const normalize = createBinaryResultNormalizer({
      getBridgeMaxPayloadSize: () => 1000,
      createBridgeError: bridgeError,
      normalizeResult: async () => payload,
    });

    await expect(normalize('input', 'fallback.zip')).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message:
        '"gerbers.zip" is 601 bytes, which exceeds the safe transport budget (600 bytes, derived from the server\'s BRIDGE_MAX_PAYLOAD_SIZE=1000).',
      suggestion:
        'Increase BRIDGE_MAX_PAYLOAD_SIZE in the MCP server environment, or (for canvas captures) zoom to a smaller region.',
    });
  });

  it('does not mistake partial lookalike objects for binary payloads', async () => {
    const getBridgeMaxPayloadSize = vi.fn(() => 1);
    const lookalike = { base64: 'YQ==', byteLength: '1000' };
    const normalize = createBinaryResultNormalizer({
      getBridgeMaxPayloadSize,
      createBridgeError: bridgeError,
      normalizeResult: async () => lookalike,
    });

    await expect(normalize('input', 'fallback.bin')).resolves.toBe(lookalike);
    expect(getBridgeMaxPayloadSize).not.toHaveBeenCalled();
  });
});
