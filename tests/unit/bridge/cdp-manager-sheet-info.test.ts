import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CdpBridgeManager } from '../../../src/bridge/cdp-manager.js';
import { EnvSchema } from '../../../src/config/env.js';

function sheetInfoExpression(params: Record<string, unknown>): string {
  const manager = new CdpBridgeManager(EnvSchema.parse({ NODE_ENV: 'test' }));
  return (
    manager as unknown as {
      sheetInfoExpression(params?: Record<string, unknown>): string;
    }
  ).sheetInfoExpression(params);
}

describe('CdpBridgeManager sheet scope', () => {
  it('selects a non-focused page with DMT metadata and never emits focus-changing APIs', async () => {
    const focusedPage = { uuid: 'page-1', name: 'Main' };
    const listedTarget = { uuid: 'page-2', name: 'Power' };
    const detailedTarget = { uuid: 'page-2', name: 'Power', width: 420 };
    const getSchematicPageInfo = vi.fn(async (uuid: string) =>
      uuid === 'page-2' ? detailedTarget : undefined,
    );
    const expression = sheetInfoExpression({ pageUuid: 'page-2' });
    expect(expression).not.toMatch(/openDocument|activateDocument/);

    const context = vm.createContext({
      eda: {
        DMT_Schematic: {
          getCurrentSchematicPageInfo: async () => focusedPage,
          getCurrentSchematicAllSchematicPagesInfo: async () => [focusedPage, listedTarget],
          getSchematicPageInfo,
        },
        DMT_SelectControl: {
          getCurrentDocumentInfo: async () => ({ uuid: 'page-1', documentType: 'schematic' }),
        },
      },
    });

    await expect(vm.runInContext(expression, context)).resolves.toMatchObject({
      currentPage: detailedTarget,
      pages: [focusedPage, listedTarget],
      source: 'requested_page',
      focusedDocument: { uuid: 'page-1', documentType: 'schematic' },
      diagnostics: {
        stage: 'page_scope_resolution',
        requestedScope: 'page',
        requestedPageUuid: 'page-2',
        focusedPageUuid: 'page-1',
      },
    });
    expect(getSchematicPageInfo).toHaveBeenCalledWith('page-2');
  });

  it('falls back to verified page-list metadata when direct page UUID mismatches', async () => {
    const listedTarget = { uuid: 'page-2', name: 'Power' };
    const expression = sheetInfoExpression({ pageUuid: 'page-2' });
    const context = vm.createContext({
      eda: {
        DMT_Schematic: {
          getCurrentSchematicPageInfo: async () => ({ uuid: 'page-1' }),
          getCurrentSchematicAllSchematicPagesInfo: async () => [{ uuid: 'page-1' }, listedTarget],
          getSchematicPageInfo: async () => ({ uuid: 'page-3', width: 999 }),
        },
        DMT_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'page-1' }) },
      },
    });

    await expect(vm.runInContext(expression, context)).resolves.toMatchObject({
      currentPage: listedTarget,
      source: 'page_list',
    });
  });

  it('rejects an unknown page before the direct DMT page lookup', async () => {
    const getSchematicPageInfo = vi.fn(async () => ({ uuid: 'unexpected' }));
    const expression = sheetInfoExpression({ pageUuid: 'missing' });
    const context = vm.createContext({
      eda: {
        DMT_Schematic: {
          getCurrentSchematicPageInfo: async () => ({ uuid: 'page-1' }),
          getCurrentSchematicAllSchematicPagesInfo: async () => [
            { uuid: 'page-1' },
            { uuid: 'page-2' },
          ],
          getSchematicPageInfo,
        },
        DMT_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'page-1' }) },
      },
    });

    await expect(vm.runInContext(expression, context)).resolves.toMatchObject({
      __easyedaBridgeError: {
        code: 'PAGE_NOT_FOUND',
        suggestion: expect.any(String),
        data: expect.objectContaining({ pageUuid: 'missing' }),
      },
    });
    expect(getSchematicPageInfo).not.toHaveBeenCalled();
  });
});
