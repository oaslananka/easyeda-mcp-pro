import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BridgeRequestSchema, BridgeResponseSchema } from '../../../src/bridge/protocol.js';
import { RelayMessageSchema } from '../../../src/remote/protocol.js';

const PROPERTY_RUNS = 500;
const BRIDGE_SEED = 0x51_7a_2026;
const REMOTE_SEED = 0x24_07_2026;

function stableOutcome(result: { success: boolean }): boolean {
  return result.success;
}

describe('protocol boundary properties', () => {
  it('parses arbitrary bridge JSON deterministically without throwing', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 5 }), (candidate) => {
        const requestFirst = BridgeRequestSchema.safeParse(candidate);
        const requestSecond = BridgeRequestSchema.safeParse(candidate);
        const responseFirst = BridgeResponseSchema.safeParse(candidate);
        const responseSecond = BridgeResponseSchema.safeParse(candidate);

        expect(stableOutcome(requestFirst)).toBe(stableOutcome(requestSecond));
        expect(stableOutcome(responseFirst)).toBe(stableOutcome(responseSecond));

        if (requestFirst.success) {
          expect(requestFirst.data.type).toBe('request');
          expect(requestFirst.data.id.length).toBeGreaterThan(0);
          expect(requestFirst.data.method.length).toBeGreaterThan(0);
        }
        if (responseFirst.success) {
          expect(responseFirst.data.type).toBe('response');
          expect(Number.isFinite(responseFirst.data.durationMs)).toBe(true);
        }
      }),
      { seed: BRIDGE_SEED, numRuns: PROPERTY_RUNS, endOnFailure: true },
    );
  });

  it('parses arbitrary remote relay JSON deterministically and fails closed', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 5 }), (candidate) => {
        const first = RelayMessageSchema.safeParse(candidate);
        const second = RelayMessageSchema.safeParse(candidate);

        expect(stableOutcome(first)).toBe(stableOutcome(second));
        if (first.success) {
          expect(first.data.protocolVersion).toBe('2026-07-remote-relay-v1');
          expect(first.data.messageId.length).toBeGreaterThan(0);
          expect(Number.isNaN(Date.parse(first.data.timestamp))).toBe(false);
        }
      }),
      { seed: REMOTE_SEED, numRuns: PROPERTY_RUNS, endOnFailure: true },
    );
  });
});
