import { describe, expect, it, vi } from 'vitest';
import { createProjectOperations } from '../src/project-operations.js';
import { createExportOperations } from '../src/export-operations.js';

type Handler = (...args: unknown[]) => unknown;

const project = {
  uuid: 'p1',
  data: [
    {
      name: 'Board1',
      pcb: { uuid: 'pcb1', name: 'PCB1' },
      schematic: { uuid: 'sch1', page: [{ uuid: 'page1', name: 'P1' }] },
    },
  ],
};
const startTab = { tabId: 'tab_page1', title: 'Start Page', data: { doctype: -1 } };

function nativeApi(handlers: Record<string, Handler>) {
  return vi.fn(async (paths: readonly string[], ...args: unknown[]) => {
    const handler = handlers[paths[0] ?? ''];
    if (!handler) throw new Error(`unexpected native call ${paths[0]}`);
    return handler(...args);
  });
}

describe('document.activate', () => {
  it('opens, activates and verifies the focused document by read-back', async () => {
    let focused: unknown = { uuid: 'pcb1', parentProjectUuid: 'p1', documentType: 3 };
    const callFirst = nativeApi({
      'dmt_Project.getCurrentProjectInfo': () => project,
      'dmt_EditorControl.openDocument': () => 'page1@p1',
      'dmt_EditorControl.activateDocument': () => {
        focused = { uuid: 'page1', parentProjectUuid: 'p1', documentType: 1 };
        return true;
      },
      'dmt_SelectControl.getCurrentDocumentInfo': () => focused,
    });
    const operations = createProjectOperations({ callFirst });

    await expect(
      operations.activateDocument({ projectId: 'p1', documentId: 'page1' }),
    ).resolves.toEqual({
      success: true,
      status: 'activated',
      projectId: 'p1',
      documentId: 'page1',
      type: 'schematic',
      tabId: 'page1@p1',
    });
    expect(callFirst).toHaveBeenCalledWith(['dmt_EditorControl.openDocument'], 'page1');
  });

  it('refuses a document outside the active project without opening anything', async () => {
    const callFirst = nativeApi({ 'dmt_Project.getCurrentProjectInfo': () => project });
    const operations = createProjectOperations({ callFirst });

    await expect(
      operations.activateDocument({ projectId: 'p1', documentId: 'other' }),
    ).resolves.toMatchObject({ success: false, status: 'document_not_in_project' });
    await expect(
      operations.activateDocument({ projectId: 'p2', documentId: 'pcb1' }),
    ).resolves.toMatchObject({ success: false, status: 'project_not_active' });
    expect(callFirst).not.toHaveBeenCalledWith(
      ['dmt_EditorControl.openDocument'],
      expect.anything(),
    );
  });

  it('does not claim activation when the focus never changes', async () => {
    vi.useFakeTimers();
    try {
      const callFirst = nativeApi({
        'dmt_Project.getCurrentProjectInfo': () => project,
        'dmt_EditorControl.openDocument': () => 'page1@p1',
        'dmt_EditorControl.activateDocument': () => true,
        'dmt_SelectControl.getCurrentDocumentInfo': () => ({
          uuid: 'pcb1',
          parentProjectUuid: 'p1',
        }),
      });
      const operations = createProjectOperations({ callFirst });
      const result = operations.activateDocument({ projectId: 'p1', documentId: 'page1' });
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ success: false, status: 'focus_not_verified' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('project.create', () => {
  it('requires confirmWrite before any native call', async () => {
    const callFirst = nativeApi({});
    const operations = createProjectOperations({ callFirst });
    await expect(operations.create({ friendlyName: 'New' })).resolves.toEqual({
      success: false,
      status: 'confirm_write_required',
    });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('refuses to switch projects while a user document tab is open', async () => {
    const callFirst = nativeApi({
      'dmt_EditorControl.getSplitScreenTree': () => ({
        tabs: [startTab, { tabId: 'pcb9@p9', title: 'PCB', data: { doctype: 3, pid: 'p9' } }],
      }),
    });
    const operations = createProjectOperations({ callFirst });
    await expect(operations.create({ friendlyName: 'New', confirmWrite: true })).resolves.toEqual({
      success: false,
      status: 'open_documents_may_be_dirty',
    });
    expect(callFirst).not.toHaveBeenCalledWith(
      ['dmt_Project.createProject'],
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('creates, opens and waits for the default board documents', async () => {
    const created = { ...project, uuid: 'new1' };
    let reads = 0;
    const callFirst = nativeApi({
      'dmt_EditorControl.getSplitScreenTree': () => ({ tabs: [startTab] }),
      'dmt_Project.createProject': () => 'new1',
      'dmt_Project.openProject': () => true,
      'dmt_Project.waitForReady': () => true,
      // EasyEDA builds the default board asynchronously: the first read has no PCB yet.
      'dmt_Project.getCurrentProjectInfo': () =>
        ++reads === 1 ? { uuid: 'new1', data: [{ name: 'Board1', pcb: null }] } : created,
    });
    const operations = createProjectOperations({ callFirst });

    const result = (await operations.create({
      friendlyName: 'New',
      projectName: 'New',
      description: 'test',
      confirmWrite: true,
    })) as { success: boolean; status: string; projectId: string; documents: unknown[] };
    expect(result).toMatchObject({
      success: true,
      status: 'created_and_opened',
      projectId: 'new1',
    });
    expect(result.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: 'pcb1', type: 'pcb' }),
        expect.objectContaining({ documentId: 'page1', type: 'schematic' }),
      ]),
    );
    expect(callFirst).toHaveBeenCalledWith(
      ['dmt_Project.createProject'],
      'New',
      'New',
      undefined,
      undefined,
      'test',
    );
  });
});

describe('pcb.importFromSchematic', () => {
  it('imports the schematic of the focused PCB with force', async () => {
    const callFirst = nativeApi({
      'dmt_Project.getCurrentProjectInfo': () => project,
      'dmt_SelectControl.getCurrentDocumentInfo': () => ({
        uuid: 'pcb1',
        parentProjectUuid: 'p1',
        documentType: 3,
      }),
      'pcb_Document.importChanges': () => true,
    });
    const operations = createProjectOperations({ callFirst });

    await expect(
      operations.importSchematicToPcb({ projectId: 'p1', confirmWrite: true }),
    ).resolves.toEqual({
      success: true,
      status: 'imported',
      projectId: 'p1',
      pcbId: 'pcb1',
      schematicId: 'sch1',
    });
    expect(callFirst).toHaveBeenCalledWith(['pcb_Document.importChanges'], 'sch1', true);
  });

  it('refuses when the PCB is not focused or confirmWrite is missing', async () => {
    const callFirst = nativeApi({
      'dmt_Project.getCurrentProjectInfo': () => project,
      'dmt_SelectControl.getCurrentDocumentInfo': () => ({
        uuid: 'page1',
        parentProjectUuid: 'p1',
        documentType: 1,
      }),
    });
    const operations = createProjectOperations({ callFirst });
    await expect(operations.importSchematicToPcb({ projectId: 'p1' })).resolves.toMatchObject({
      status: 'confirm_write_required',
    });
    await expect(
      operations.importSchematicToPcb({ projectId: 'p1', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'pcb_not_focused' });
    expect(callFirst).not.toHaveBeenCalledWith(
      ['pcb_Document.importChanges'],
      expect.anything(),
      expect.anything(),
    );
  });

  it('reports a native refusal instead of success', async () => {
    const callFirst = nativeApi({
      'dmt_Project.getCurrentProjectInfo': () => project,
      'dmt_SelectControl.getCurrentDocumentInfo': () => ({
        uuid: 'pcb1',
        parentProjectUuid: 'p1',
        documentType: 3,
      }),
      'pcb_Document.importChanges': () => false,
    });
    const operations = createProjectOperations({ callFirst });
    await expect(
      operations.importSchematicToPcb({ projectId: 'p1', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'native_import_failed' });
  });
});

describe('board.export3d', () => {
  function exportOperations(focusedType: number, file: unknown) {
    const callFirst = vi.fn(async (paths: readonly string[]) =>
      paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo'
        ? { documentType: focusedType }
        : file,
    );
    const normalizeBinaryResult = vi.fn(async (value: unknown, name: string) => ({ value, name }));
    const createBridgeError = vi.fn((code: string, message: string) => {
      const error = new Error(message) as Error & { code: string };
      error.code = code;
      return error;
    });
    return {
      callFirst,
      operations: createExportOperations({
        callFirst,
        normalizeBinaryResult,
        createBridgeError,
      } as never),
    };
  }

  it('exports STEP with the documented argument order and defaults', async () => {
    const { callFirst, operations } = exportOperations(3, 'FILE');
    await expect(operations.export3d({ projectId: 'p1', fileName: 'p1-3d' })).resolves.toEqual({
      value: 'FILE',
      name: 'board.step',
    });
    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_ManufactureData.get3DFile'],
      'p1-3d',
      'step',
      ['Component Model'],
      'Outfit',
      true,
    );
  });

  it('refuses when the PCB is not focused and filters unknown elements', async () => {
    const notPcb = exportOperations(1, 'FILE');
    await expect(notPcb.operations.export3d({ projectId: 'p1' })).rejects.toThrow(/PCB document/);

    const pcb = exportOperations(3, 'FILE');
    await pcb.operations.export3d({ projectId: 'p1', fileType: 'obj', elements: ['Via', 'Bogus'] });
    expect(pcb.callFirst).toHaveBeenCalledWith(
      ['PCB_ManufactureData.get3DFile'],
      'board-3d',
      'obj',
      ['Via'],
      'Outfit',
      true,
    );
  });

  it('reports a missing native file as an error, not an empty export', async () => {
    const { operations } = exportOperations(3, undefined);
    await expect(operations.export3d({ projectId: 'p1' })).rejects.toThrow(
      /did not return a 3D file/,
    );
  });
});
