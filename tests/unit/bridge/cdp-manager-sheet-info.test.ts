import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { CdpBridgeManager } from '../../../src/bridge/cdp-manager.js';

function sheetInfoExpression(): string {
  const config = EnvSchema.parse({ NODE_ENV: 'test' });
  const manager = new CdpBridgeManager(config);
  return (manager as unknown as { sheetInfoExpression(): string }).sheetInfoExpression();
}

describe('CdpBridgeManager sheet info fallback', () => {
  it('resolves a focused schematic page through DMT_SelectControl', async () => {
    const page = {
      uuid: 'page-1',
      name: 'Sheet 1',
      parentSchematicUuid: 'sch-1',
      showTitleBlock: true,
      titleBlockData: {},
    };
    const context = vm.createContext({
      eda: {
        DMT_SelectControl: {
          getCurrentDocumentInfo: async () => ({ uuid: 'page-1', tabId: 'tab-1' }),
        },
        DMT_Schematic: {
          getCurrentSchematicPageInfo: async () => null,
          getCurrentSchematicAllSchematicPagesInfo: async () => [],
          getAllSchematicPagesInfo: async () => [],
          getCurrentSchematicInfo: async () => ({ uuid: 'sch-1', page: [page] }),
          getSchematicPageInfo: async (uuid: string) => (uuid === 'page-1' ? page : undefined),
        },
      },
    });

    const result = await vm.runInContext(sheetInfoExpression(), context);

    expect(result).toMatchObject({
      currentPage: page,
      pages: [page],
      source: 'focused_document',
      focusedDocument: { uuid: 'page-1', tabId: 'tab-1' },
      diagnostics: { currentPageAvailable: true, pageListAvailable: true },
    });
  });

  it('rejects empty focused-sheet metadata instead of returning a valid empty object', async () => {
    const context = vm.createContext({
      eda: {
        DMT_SelectControl: { getCurrentDocumentInfo: async () => undefined },
        DMT_Schematic: {
          getCurrentSchematicPageInfo: async () => null,
          getCurrentSchematicAllSchematicPagesInfo: async () => [],
          getAllSchematicPagesInfo: async () => [],
          getCurrentSchematicInfo: async () => undefined,
        },
      },
    });

    await expect(vm.runInContext(sheetInfoExpression(), context)).rejects.toMatchObject({
      code: 'SHEET_INFO_UNAVAILABLE',
      data: { stage: 'focused_sheet_resolution', currentPageAvailable: false },
    });
  });
});
