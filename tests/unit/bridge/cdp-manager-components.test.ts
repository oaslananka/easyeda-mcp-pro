import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { CdpBridgeManager } from '../../../src/bridge/cdp-manager.js';

function componentListExpression(allPages?: boolean): string {
  const manager = new CdpBridgeManager(EnvSchema.parse({ NODE_ENV: 'test' }));
  return (
    manager as unknown as {
      componentListExpression(params?: { allPages?: boolean }): string;
    }
  ).componentListExpression(allPages === undefined ? {} : { allPages });
}

describe('CdpBridgeManager component scope', () => {
  it('passes explicit focused/all-pages scope to the documented native getAll flag', async () => {
    const getAll = vi.fn(async () => []);
    const context = vm.createContext({ eda: { SCH_PrimitiveComponent: { getAll } } });

    await vm.runInContext(componentListExpression(false), context);
    expect(getAll).toHaveBeenLastCalledWith(undefined, false);

    await vm.runInContext(componentListExpression(true), context);
    expect(getAll).toHaveBeenLastCalledWith(undefined, true);
  });

  it('preserves the legacy all-pages flag when scope is omitted', async () => {
    const getAll = vi.fn(async () => []);
    const context = vm.createContext({ eda: { SCH_PrimitiveComponent: { getAll } } });

    await vm.runInContext(componentListExpression(), context);
    expect(getAll).toHaveBeenLastCalledWith(undefined, true);
  });
});
