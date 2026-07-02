import { describe, it, expect } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { JlcpcbClient } from '../../../src/vendors/jlcpcb/client.js';

function createEnabledConfig() {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    JLCPCB_MODE: 'approved_api',
    JLCPCB_CLIENT_ID: 'test-client-id',
    JLCPCB_CLIENT_SECRET: 'test-client-secret',
  });
}

function createDisabledConfig() {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    JLCPCB_MODE: 'disabled',
  });
}

describe('JlcpcbClient', () => {
  it('should construct when credentials are present', () => {
    const config = createEnabledConfig();
    const client = new JlcpcbClient(config);
    expect(client).toBeInstanceOf(JlcpcbClient);
  });

  it('should throw when JLCPCB_MODE is disabled', () => {
    const config = createDisabledConfig();
    expect(() => new JlcpcbClient(config)).toThrow('JLCPCB API is not enabled');
  });

  it('should throw when credentials are missing in approved_api mode', () => {
    const config = EnvSchema.parse({
      NODE_ENV: 'test',
      JLCPCB_MODE: 'approved_api',
      JLCPCB_CLIENT_ID: '',
      JLCPCB_CLIENT_SECRET: '',
    });
    expect(() => new JlcpcbClient(config)).toThrow('JLCPCB credentials are missing');
  });

  it('should reject paid workflow method', async () => {
    const config = createEnabledConfig();
    const client = new JlcpcbClient(config);

    await expect(
      client.placeOrder({ boardCount: 5, layers: 2, width: 50, height: 30 }),
    ).rejects.toThrow('intentionally unsupported');
  });

  it('should have expected methods', () => {
    const config = createEnabledConfig();
    const client = new JlcpcbClient(config);
    expect(typeof client.getQuote).toBe('function');
    expect(typeof client.placeOrder).toBe('function');
    expect(typeof client.getOrderStatus).toBe('function');
    expect(typeof client.checkCapabilities).toBe('function');
  });
});
