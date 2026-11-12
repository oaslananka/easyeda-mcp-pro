import { describe, expect, it, vi } from 'vitest';
import { createProjectOperations } from '../src/project-operations.js';

describe('project operations', () => {
  it('saves through the exact zero-argument fallback chain', async () => {
    const callFirst = vi.fn(async () => 'saved');
    const operations = createProjectOperations({ callFirst });

    await expect(operations.save({ projectId: 'ignored' })).resolves.toBe('saved');
    expect(callFirst).toHaveBeenCalledWith([
      'dmt_Workspace.saveAll',
      'dmt_Workspace.saveActiveDocument',
      'sch_Document.save',
      'pcb_Document.save',
      'pnl_Document.save',
    ]);
  });

  it('exports with the original path order and exact params object', async () => {
    const callFirst = vi.fn(async () => 'exported');
    const operations = createProjectOperations({ callFirst });
    const params = { projectId: 'project-1', format: 'zip', includeLibraries: true };

    await expect(operations.export(params)).resolves.toBe('exported');
    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_ManufactureData.getManufactureData', 'SCH_ManufactureData.getExportDocumentFile'],
      params,
    );
  });
});

describe('project lifecycle safety', () => {
  const project = {
    uuid: 'p1',
    teamUuid: 'team-a',
    friendlyName: 'Alpha',
    data: [
      {
        name: 'Board',
        pcb: { uuid: 'pcb1', name: 'PCB1' },
        schematic: { page: [{ uuid: 'sch1', name: 'P1' }] },
      },
    ],
  };
  function fixture(overrides?: {
    active?: string;
    tabs?: unknown[];
    save?: boolean;
    readyDelayReads?: number;
    closeReadbackDelay?: number;
  }) {
    let active = overrides?.active ?? 'p1';
    let currentReadCount = 0;
    let pendingClose: string | undefined;
    let pendingReadbacks = 0;
    let tabs = overrides?.tabs ?? [
      { tabId: 'start', title: 'Start Page', data: { doctype: 'start' } },
      { tabId: 'pcb1-extended-native-tab', title: 'PCB1', data: { pid: 'p1', creator: 'pcb1' } },
    ];
    const callFirst = vi.fn(
      async (paths: readonly string[], ...args: unknown[]): Promise<unknown> => {
        switch (paths[0]) {
          case 'dmt_Team.getAllTeamsInfo':
            return [{ uuid: 'team-a', name: 'Personal' }];
          case 'dmt_Project.getAllProjectsUuid':
            return ['p1', 'p2'];
          case 'dmt_Project.getProjectInfo':
            return { uuid: args[0], friendlyName: args[0] === 'p1' ? 'Alpha' : 'Beta' };
          case 'dmt_Project.getCurrentProjectInfo':
            currentReadCount++;
            return {
              ...project,
              uuid: active,
              data: currentReadCount <= (overrides?.readyDelayReads ?? 0) ? [] : project.data,
            };
          case 'dmt_EditorControl.getSplitScreenTree':
            if (pendingClose) {
              if (pendingReadbacks > 0) pendingReadbacks--;
              else {
                tabs = tabs.filter((tab: any) => tab.tabId !== pendingClose);
                pendingClose = undefined;
              }
            }
            return { id: 'root', tabs };
          case 'dmt_Project.openProject':
            active = args[0] as string;
            return true;
          case 'dmt_EditorControl.activateDocument':
            return true;
          case 'dmt_SelectControl.getCurrentDocumentInfo':
            return { uuid: 'pcb1', parentProjectUuid: 'p1', documentType: 3 };
          case 'pcb_Document.save':
            return overrides?.save !== false;
          case 'dmt_EditorControl.closeDocument':
            if (overrides?.closeReadbackDelay) {
              pendingClose = args[0] as string;
              pendingReadbacks = overrides.closeReadbackDelay;
            } else {
              tabs = tabs.filter((tab: any) => tab.tabId !== args[0]);
            }
            return true;
          default:
            throw Error('unexpected native call: ' + paths[0]);
        }
      },
    );
    return { callFirst, operations: createProjectOperations({ callFirst }) };
  }

  it('lists the scoped workspace projects with truthful active/open markers', async () => {
    const { operations, callFirst } = fixture();
    await expect(operations.list({})).resolves.toMatchObject({
      status: 'ok',
      projects: [
        { projectId: 'p1', name: 'Alpha', active: true, open: true },
        { projectId: 'p2', name: 'Beta', active: false, open: null },
      ],
    });
    expect(callFirst).toHaveBeenCalledWith(['dmt_Project.getAllProjectsUuid'], 'team-a');
  });

  it('does not switch away from any open project document (dirty state cannot be proved)', async () => {
    const { operations, callFirst } = fixture();
    await expect(operations.open({ projectId: 'p2', confirmWrite: true })).resolves.toMatchObject({
      success: false,
      status: 'open_documents_may_be_dirty',
    });
    expect(callFirst).not.toHaveBeenCalledWith(['dmt_Project.openProject'], 'p2');
  });

  it('opening the already active project is idempotent and returns document evidence', async () => {
    const { operations, callFirst } = fixture();
    const result = await operations.open({ projectId: 'p1' });
    expect(result).toMatchObject({
      success: true,
      status: 'already_active',
      projectId: 'p1',
      documents: expect.arrayContaining([
        { documentId: 'pcb1', type: 'pcb', tabId: 'pcb1-extended-native-tab' },
      ]),
    });
    expect(callFirst).not.toHaveBeenCalledWith(['dmt_Project.openProject'], 'p1');
  });

  it('opens and verifies a different project only from an empty start screen', async () => {
    const { operations, callFirst } = fixture({
      tabs: [{ tabId: 'start', title: 'Start Page', data: { doctype: 'start' } }],
    });
    const result = await operations.open({ projectId: 'p2', confirmWrite: true });
    expect(result).toMatchObject({ success: true, status: 'opened', projectId: 'p2' });
    expect(callFirst).toHaveBeenCalledWith(['dmt_Project.openProject'], 'p2');
  });

  it('waits for a real source document tree instead of returning an empty successful open', async () => {
    const { operations, callFirst } = fixture({
      tabs: [{ tabId: 'start', title: 'Start Page', data: { doctype: 'start' } }],
      readyDelayReads: 2,
    });
    const result: any = await operations.open({ projectId: 'p2', confirmWrite: true });
    expect(result).toMatchObject({ success: true, status: 'opened' });
    expect(result.documents).toContainEqual({ documentId: 'pcb1', type: 'pcb', tabId: null });
    expect(
      callFirst.mock.calls.filter(([paths]) => paths[0] === 'dmt_Project.getCurrentProjectInfo')
        .length,
    ).toBeGreaterThan(2);
    expect(
      callFirst.mock.calls.filter(([paths]) => paths[0] === 'dmt_Project.openProject'),
    ).toHaveLength(1);
  });

  it('refuses to close any open document in default mode when dirty state is unavailable', async () => {
    const { operations, callFirst } = fixture();
    await expect(operations.close({ projectId: 'p1' })).resolves.toMatchObject({
      success: false,
      status: 'dirty_state_unavailable',
    });
    expect(callFirst).not.toHaveBeenCalledWith(['dmt_EditorControl.closeDocument'], 'pcb1');
  });

  it('saves an explicitly confirmed PCB and only then closes and reads back the tab', async () => {
    const { operations, callFirst } = fixture();
    const result = await operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true });
    expect(result).toMatchObject({
      success: true,
      status: 'closed',
      closedTabs: ['pcb1-extended-native-tab'],
    });
    const names = callFirst.mock.calls.map(([paths]) => (paths as readonly string[])[0]);
    expect(names.indexOf('pcb_Document.save')).toBeLessThan(
      names.indexOf('dmt_EditorControl.closeDocument'),
    );
  });

  it('waits for delayed native tab closure without a second destructive close', async () => {
    const { operations, callFirst } = fixture({ closeReadbackDelay: 2 });
    const result = await operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true });
    expect(result).toMatchObject({
      success: true,
      status: 'closed',
      closedTabs: ['pcb1-extended-native-tab'],
    });
    expect(
      callFirst.mock.calls.filter(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toHaveLength(1);
    expect(
      callFirst.mock.calls.filter(([paths]) => paths[0] === 'dmt_EditorControl.getSplitScreenTree')
        .length,
    ).toBeGreaterThan(3);
  });

  it('refuses to close if save returned false', async () => {
    const { operations, callFirst } = fixture({ save: false });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'save_failed' });
    expect(callFirst).not.toHaveBeenCalledWith(['dmt_EditorControl.closeDocument'], 'pcb1');
  });

  it('never discards without confirmWrite, even via direct native method', async () => {
    const { operations, callFirst } = fixture();
    await expect(operations.close({ projectId: 'p1', mode: 'discard' })).resolves.toMatchObject({
      success: false,
      status: 'confirm_write_required',
    });
    expect(callFirst).not.toHaveBeenCalledWith(['dmt_EditorControl.closeDocument'], 'pcb1');
  });

  it.each([
    [
      'wrong owning project',
      { tabId: 'pcb1-extended-native-tab', title: 'PCB1', data: { pid: 'other', creator: 'pcb1' } },
    ],
    [
      'forged creator',
      { tabId: 'pcb1-extended-native-tab', title: 'PCB1', data: { pid: 'p1', creator: 'other' } },
    ],
    [
      'matching title but unrelated tab',
      { tabId: 'other', title: 'PCB1', data: { pid: 'p1', creator: 'pcb1' } },
    ],
  ])('refuses %s before saving or closing', async (_, tab) => {
    const { operations, callFirst } = fixture({
      tabs: [{ tabId: 'start', title: 'Start Page', data: { doctype: 'start' } }, tab],
    });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'unknown_document_tabs' });
    expect(callFirst).not.toHaveBeenCalledWith(['pcb_Document.save']);
    expect(
      callFirst.mock.calls.some(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toBe(false);
  });

  it('refuses unknown tabs before saving or closing any document', async () => {
    const { operations, callFirst } = fixture({
      tabs: [{ tabId: 'unrelated', title: 'Other project document', data: { pid: 'other' } }],
    });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'unknown_document_tabs' });
    expect(callFirst).not.toHaveBeenCalledWith(['pcb_Document.save']);
  });
});
