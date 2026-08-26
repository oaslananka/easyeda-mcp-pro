import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import {
  getGlobalTransactionManager,
  resetGlobalTransactionManagerForTests,
} from '../../../src/transactions/manager.js';
import { registerPcbWriteTools } from '../../../src/tools/L1_pcb_write.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';

const initialComponentState = {
  primitiveId: 'comp-1',
  x: 10,
  y: 20,
  rotation: 0,
  layer: 1,
  locked: false,
};

describe('PCB component transform resilience', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerPcbWriteTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    resetGlobalTransactionManagerForTests();
    bridgeCall = vi.fn();
    context = {
      profile: 'full',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    };
  });

  it('fails closed when rollback reports an incomplete transaction state', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    const manager = getGlobalTransactionManager();
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listComponents') {
        return { total: 1, items: [{ ...initialComponentState }] };
      }
      if (method === 'pcb.modifyComponent') throw new Error('native write failed');
      throw new Error(`unexpected method ${method}`);
    });
    vi.spyOn(manager, 'rollback').mockResolvedValueOnce({
      transaction: { state: 'failed', rollbackComplete: false },
      restoredOperationIds: [],
      failedOperationIds: ['op-1'],
    } as never);

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      xMil: 15,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: false,
      transaction_state: 'failed',
    });
    expect(result?.error).toContain('native write failed');
  });

  it('preserves non-Error rollback failures', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    const manager = getGlobalTransactionManager();
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listComponents') {
        return { total: 1, items: [{ ...initialComponentState }] };
      }
      if (method === 'pcb.modifyComponent') throw new Error('native write failed');
      throw new Error(`unexpected method ${method}`);
    });
    vi.spyOn(manager, 'rollback').mockRejectedValueOnce('rollback transport unavailable');

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      xMil: 15,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: false,
      transaction_state: 'failed',
    });
    expect(result?.error).toContain('native write failed');
    expect(result?.error).toContain('rollback failed: rollback transport unavailable');
  });

  it('fails validation when the transaction snapshot is mismatched', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    const manager = getGlobalTransactionManager();
    bridgeCall.mockResolvedValue({ total: 1, items: [{ ...initialComponentState }] });
    vi.spyOn(manager, 'runModify').mockResolvedValueOnce({
      result: undefined,
      operation: {
        afterSnapshot: {
          primitiveId: 'comp-1',
          side: 'top',
          layer: 1,
          xMil: 10,
          yMil: 20,
          rotationDeg: 0,
          locked: false,
        },
      },
    } as never);

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      side: 'bottom',
      xMil: 15,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: true,
      transaction_state: 'rolled-back',
    });
    expect(result?.error).toContain('transaction validation gate');
  });

  it('normalizes a non-Error transaction apply failure', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    const manager = getGlobalTransactionManager();
    bridgeCall.mockResolvedValue({ total: 1, items: [{ ...initialComponentState }] });
    vi.spyOn(manager, 'runModify').mockRejectedValueOnce('transaction apply unavailable');

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      xMil: 15,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      applied: false,
      rolled_back: true,
      transaction_state: 'rolled-back',
    });
    expect(result?.error).toContain('transaction apply unavailable');
  });

  it('keeps the captured state when transaction startup throws a non-Error', async () => {
    const tool = registry.get('easyeda_pcb_modify_component');
    const manager = getGlobalTransactionManager();
    const bootstrapFailure: unknown = 'transaction bootstrap unavailable';
    bridgeCall.mockResolvedValue({ total: 1, items: [{ ...initialComponentState }] });
    vi.spyOn(manager, 'begin').mockImplementationOnce(() => {
      throw bootstrapFailure;
    });

    const result = await tool?.handler(context, {
      primitiveId: 'comp-1',
      mode: 'apply',
      xMil: 15,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      applied: false,
      before: { side: 'top', layer: 1, xMil: 10, yMil: 20, rotationDeg: 0, locked: false },
      error: 'transaction bootstrap unavailable',
    });
  });
});
