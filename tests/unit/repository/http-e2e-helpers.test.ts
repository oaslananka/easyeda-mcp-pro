import { describe, expect, it, vi } from 'vitest';
import {
  findDeviceCandidates,
  initializeHttpSession,
  waitForBridgeConnection,
} from '../../../scripts/e2e/http-helpers.mjs';

describe('HTTP live E2E helpers', () => {
  it('initializes the MCP session and sends the initialized notification', async () => {
    const mcpCall = vi.fn(async () => ({ ok: true }));
    const sendInitializedNotification = vi.fn(async () => undefined);

    await initializeHttpSession({ mcpCall, sendInitializedNotification });

    expect(mcpCall).toHaveBeenCalledWith('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e-http', version: '1.0' },
    });
    expect(sendInitializedNotification).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when the bridge is connected', async () => {
    const toolCall = vi.fn(async () => ({
      text: JSON.stringify({ connected: true, version: '1.2.3' }),
    }));
    const sleep = vi.fn(async () => undefined);
    const log = vi.fn();

    await expect(
      waitForBridgeConnection({ toolCall, maxWaitSeconds: 120, sleep, log }),
    ).resolves.toEqual({ connected: true, version: '1.2.3' });
    expect(toolCall).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('uses the unknown version marker when connected status omits the version', async () => {
    const toolCall = vi.fn(async () => ({ text: JSON.stringify({ connected: true }) }));

    await expect(
      waitForBridgeConnection({
        toolCall,
        maxWaitSeconds: 1,
        sleep: vi.fn(async () => undefined),
        log: vi.fn(),
      }),
    ).resolves.toEqual({ connected: true, version: '?' });
  });

  it('bounds bridge retries while tolerating malformed and disconnected status responses', async () => {
    const toolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: 'not-json' })
      .mockResolvedValueOnce({ text: JSON.stringify({ connected: false }) });
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForBridgeConnection({ toolCall, maxWaitSeconds: 2, sleep, log: vi.fn() }),
    ).resolves.toEqual({ connected: false, version: '?' });
    expect(toolCall).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('reports every 15 seconds while waiting for the bridge', async () => {
    const toolCall = vi.fn(async () => ({ text: JSON.stringify({ connected: false }) }));
    const sleep = vi.fn(async () => undefined);
    const log = vi.fn();

    await waitForBridgeConnection({ toolCall, maxWaitSeconds: 15, sleep, log });

    expect(log).toHaveBeenCalledWith('  ⏳ waiting for bridge... 15s');
    expect(sleep).toHaveBeenCalledTimes(15);
  });

  it('uses the default timer and console adapters when no test adapters are supplied', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const toolCall = vi.fn(async () => ({ text: JSON.stringify({ connected: false }) }));

    try {
      const result = waitForBridgeConnection({ toolCall, maxWaitSeconds: 15 });
      for (let second = 0; second < 15; second += 1) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      await expect(result).resolves.toEqual({ connected: false, version: '?' });
      expect(log).toHaveBeenCalledWith('  ⏳ waiting for bridge... 15s');
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it('tries device keywords until it finds at least two candidates', async () => {
    const first = { uuid: 'one' };
    const second = { uuid: 'two' };
    const toolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ devices: [first] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ results: [first, second] }) });

    await expect(findDeviceCandidates({ toolCall })).resolves.toEqual([first, second]);
    expect(toolCall).toHaveBeenNthCalledWith(1, 'easyeda_schematic_search_device', {
      keyword: 'resistor',
      limit: 10,
    });
    expect(toolCall).toHaveBeenNthCalledWith(2, 'easyeda_schematic_search_device', {
      keyword: 'R_0603',
      limit: 10,
    });
  });

  it('returns the final bounded device result when fewer than two are available', async () => {
    const last = { uuid: 'last' };
    const toolCall = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify({}) })
      .mockResolvedValueOnce({ text: JSON.stringify({ devices: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ devices: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ devices: [last] }) });

    await expect(findDeviceCandidates({ toolCall })).resolves.toEqual([last]);
    expect(toolCall).toHaveBeenCalledTimes(4);
  });
});
