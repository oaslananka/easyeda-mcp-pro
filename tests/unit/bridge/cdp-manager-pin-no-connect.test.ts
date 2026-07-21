import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { CdpBridgeManager } from '../../../src/bridge/cdp-manager.js';

function createManager(): CdpBridgeManager {
  return new CdpBridgeManager(EnvSchema.parse({ NODE_ENV: 'test' }));
}

function expression(
  name: 'getPinNoConnectExpression' | 'setPinNoConnectExpression',
  params: Record<string, unknown>,
): string {
  const manager = createManager();
  return (manager as unknown as Record<typeof name, (value: Record<string, unknown>) => string>)[
    name
  ](params);
}

function fakePin(primitiveId: string, pinNumber: string, initial: boolean) {
  const state = { noConnected: initial };
  const pin = {
    getState_PrimitiveId: () => primitiveId,
    getState_PinNumber: () => pinNumber,
    getState_PinName: () => `PIN_${pinNumber}`,
    getState_NoConnected: () => state.noConnected,
    setState_NoConnected: (value: boolean) => {
      state.noConnected = value;
      return pin;
    },
    done: vi.fn(async () => pin),
  };
  return { pin, state };
}

describe('CdpBridgeManager pin no-connect fallback', () => {
  afterEach(() => {
    delete process.env.EASYEDA_CDP_ALLOW_WRITES;
  });

  it('reads an exact native component-pin no-connect state', async () => {
    const { pin } = fakePin('pin-1', '7', true);
    const context = vm.createContext({
      eda: {
        SCH_PrimitiveComponent: {
          getAllPinsByPrimitiveId: async () => [pin],
        },
      },
    });

    const result = await vm.runInContext(
      expression('getPinNoConnectExpression', {
        primitiveId: 'comp-1',
        pinNumber: '7',
      }),
      context,
    );

    expect(result).toMatchObject({
      componentPrimitiveId: 'comp-1',
      pinPrimitiveId: 'pin-1',
      pinNumber: '7',
      pinName: 'PIN_7',
      noConnected: true,
    });
  });

  it('sets and verifies native no-connect state through the pin setter', async () => {
    const { pin } = fakePin('pin-2', '8', false);
    const context = vm.createContext({
      eda: {
        SCH_PrimitiveComponent: {
          getAllPinsByPrimitiveId: async () => [pin],
        },
      },
    });

    const result = await vm.runInContext(
      expression('setPinNoConnectExpression', {
        primitiveId: 'comp-2',
        pinNumber: '8',
        noConnected: true,
      }),
      context,
    );

    expect(result).toMatchObject({
      pinPrimitiveId: 'pin-2',
      previousNoConnected: false,
      noConnected: true,
      changed: true,
      verified: true,
    });
    expect(pin.done).toHaveBeenCalledOnce();
  });

  it('uses SCH_PrimitivePin.modify when the component-pin setter is unavailable', async () => {
    const state = { noConnected: false };
    const pin = {
      getState_PrimitiveId: () => 'pin-3',
      getState_PinNumber: () => '9',
      getState_PinName: () => 'PIN_9',
      getState_NoConnected: () => state.noConnected,
    };
    const modify = vi.fn(async (_pin: unknown, property: { noConnected: boolean }) => {
      state.noConnected = property.noConnected;
      return pin;
    });
    const context = vm.createContext({
      eda: {
        SCH_PrimitiveComponent: {
          getAllPinsByPrimitiveId: async () => [pin],
        },
        SCH_PrimitivePin: { modify },
      },
    });

    const result = await vm.runInContext(
      expression('setPinNoConnectExpression', {
        primitiveId: 'comp-3',
        pinNumber: '9',
        noConnected: true,
      }),
      context,
    );

    expect(result).toMatchObject({ noConnected: true, verified: true });
    expect(modify).toHaveBeenCalledWith(pin, { noConnected: true });
  });

  it('rejects a mapped no-connect write until disposable-project writes are enabled', async () => {
    const manager = createManager();
    const dispatchMethod = (
      manager as unknown as {
        dispatchMethod(
          method: string,
          params: Record<string, unknown>,
          timeoutMs: number,
        ): Promise<unknown>;
      }
    ).dispatchMethod.bind(manager);

    await expect(
      dispatchMethod(
        'schematic.setPinNoConnect',
        { primitiveId: 'comp-4', pinNumber: '10', noConnected: true },
        1_000,
      ),
    ).rejects.toThrow('requires EASYEDA_CDP_ALLOW_WRITES=true');
  });
});
