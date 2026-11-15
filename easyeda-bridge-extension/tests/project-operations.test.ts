import { describe, expect, it, vi } from 'vitest';
import { createProjectOperations } from '../src/project-operations.js';

describe('project operations', () => {
  it('refuses save without explicit confirmation before any native call', async () => {
    const callFirst = vi.fn(async () => true);
    const operations = createProjectOperations({ callFirst });

    await expect(operations.save({ projectId: 'p1' })).resolves.toMatchObject({
      success: false,
      status: 'confirm_write_required',
    });
    expect(callFirst).not.toHaveBeenCalled();
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
    nestedTabs?: boolean;
    projectInfoMissingFor?: string;
    nativeOpenReturnsFalse?: boolean;
    activationFails?: boolean;
    focusedProject?: string;
    focusedDocument?: string;
    focusedDocumentType?: number;
    saveThrows?: boolean;
    focusedChangesAfterSave?: boolean;
    nativeCloseReturnsFalse?: boolean;
    projectData?: unknown[];
  }) {
    let active = overrides?.active ?? 'p1';
    let currentReadCount = 0;
    let focusedChanged = false;
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
            if (overrides?.projectInfoMissingFor === args[0]) return undefined;
            return { uuid: args[0], friendlyName: args[0] === 'p1' ? 'Alpha' : 'Beta' };
          case 'dmt_Project.getCurrentProjectInfo':
            currentReadCount++;
            return {
              ...project,
              uuid: active,
              data:
                currentReadCount <= (overrides?.readyDelayReads ?? 0)
                  ? []
                  : (overrides?.projectData ?? project.data),
            };
          case 'dmt_EditorControl.getSplitScreenTree':
            if (pendingClose) {
              if (pendingReadbacks > 0) pendingReadbacks--;
              else {
                tabs = tabs.filter((tab: any) => tab.tabId !== pendingClose);
                pendingClose = undefined;
              }
            }
            return overrides?.nestedTabs
              ? { id: 'root', tabs: [], children: [{ id: 'nested', tabs }] }
              : { id: 'root', tabs };
          case 'dmt_Project.openProject':
            if (overrides?.nativeOpenReturnsFalse) return false;
            active = args[0] as string;
            return true;
          case 'dmt_EditorControl.activateDocument':
            return overrides?.activationFails !== true;
          case 'dmt_SelectControl.getCurrentDocumentInfo':
            return {
              uuid: focusedChanged ? 'sch1' : (overrides?.focusedDocument ?? 'pcb1'),
              parentProjectUuid: overrides?.focusedProject ?? 'p1',
              documentType: focusedChanged ? 1 : (overrides?.focusedDocumentType ?? 3),
            };
          case 'pcb_Document.save':
            if (overrides?.saveThrows) throw new Error('native PCB save exception');
            if (overrides?.focusedChangesAfterSave) focusedChanged = true;
            return overrides?.save !== false;
          case 'sch_Document.save':
            if (overrides?.saveThrows) throw new Error('native schematic save exception');
            return overrides?.save !== false;
          case 'dmt_EditorControl.closeDocument':
            if (overrides?.nativeCloseReturnsFalse) return false;
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

  it.each([
    ['missing project ID', { projectId: '', confirmWrite: true }, 'invalid_project_id'],
    ['wrong active project', { projectId: 'p2', confirmWrite: true }, 'active_project_mismatch'],
  ])('does not save an invalid or different project: %s', async (_name, input, status) => {
    const { operations, callFirst } = fixture();
    await expect(operations.save(input)).resolves.toMatchObject({ success: false, status });
    expect(
      callFirst.mock.calls.some(([paths]) => (paths as readonly string[])[0].includes('.save')),
    ).toBe(false);
  });

  it.each([
    ['another project', { focusedProject: 'p2' }],
    ['unknown document', { focusedDocument: 'not-a-project-document' }],
    ['unsupported type', { focusedDocumentType: 99 }],
  ])('refuses a mismatched native save target: %s', async (_name, flags) => {
    const { operations, callFirst } = fixture(flags);
    await expect(operations.save({ projectId: 'p1', confirmWrite: true })).resolves.toMatchObject({
      success: false,
      status: 'focused_document_mismatch',
    });
    expect(
      callFirst.mock.calls.some(([paths]) =>
        /\.save$|saveAll/.test((paths as readonly string[])[0] ?? ''),
      ),
    ).toBe(false);
  });

  it.each([
    ['PCB', {}, 'pcb_Document.save'],
    ['schematic', { focusedDocument: 'sch1', focusedDocumentType: 1 }, 'sch_Document.save'],
  ])(
    'saves the exact focused %s only once; never invokes workspace saveAll',
    async (_name, flags, nativePath) => {
      const { operations, callFirst } = fixture(flags);
      await expect(operations.save({ projectId: 'p1', confirmWrite: true })).resolves.toMatchObject(
        {
          success: true,
          status: 'native_save_acknowledged_persistence_unverified',
          projectId: 'p1',
        },
      );
      expect(
        callFirst.mock.calls.filter(([paths]) => (paths as readonly string[])[0].endsWith('.save')),
      ).toEqual([[[nativePath]]]);
      expect(
        callFirst.mock.calls.some(([paths]) =>
          (paths as readonly string[])[0].startsWith('dmt_Workspace.'),
        ),
      ).toBe(false);
    },
  );

  it('does not claim a stable save target when focus switches after native acknowledgment', async () => {
    const { operations, callFirst } = fixture({ focusedChangesAfterSave: true });
    await expect(operations.save({ projectId: 'p1', confirmWrite: true })).resolves.toMatchObject({
      success: false,
      status: 'target_changed_during_save',
    });
    expect(
      callFirst.mock.calls.filter(
        ([paths]) => (paths as readonly string[])[0] === 'pcb_Document.save',
      ),
    ).toHaveLength(1);
  });

  it('does not claim a save when the exact native document refuses it', async () => {
    const { operations, callFirst } = fixture({ save: false });
    await expect(operations.save({ projectId: 'p1', confirmWrite: true })).resolves.toMatchObject({
      success: false,
      status: 'native_save_unconfirmed',
    });
    expect(
      callFirst.mock.calls.filter(
        ([paths]) => (paths as readonly string[])[0] === 'pcb_Document.save',
      ),
    ).toHaveLength(1);
  });

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

  it('does not open a different project without explicit confirmation', async () => {
    const { operations, callFirst } = fixture({
      tabs: [{ tabId: 'start', title: 'Start Page', data: { doctype: 'start' } }],
    });
    await expect(operations.open({ projectId: 'p2' })).resolves.toMatchObject({
      success: false,
      status: 'confirm_write_required',
    });
    expect(callFirst.mock.calls.some(([paths]) => paths[0] === 'dmt_Project.openProject')).toBe(
      false,
    );
  });

  it.each([
    ['project_not_found', { projectInfoMissingFor: 'p2' }],
    ['native_open_failed', { nativeOpenReturnsFalse: true }],
  ])('refuses unsafe open outcome %s', async (status, flags) => {
    const { operations } = fixture({
      tabs: [{ tabId: 'start', title: 'Start Page', data: { doctype: 'start' } }],
      ...flags,
    });
    await expect(operations.open({ projectId: 'p2', confirmWrite: true })).resolves.toMatchObject({
      success: false,
      status,
    });
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

  it('recognizes genuinely nested native split-screen tabs', async () => {
    const { operations } = fixture({ nestedTabs: true });
    await expect(operations.close({ projectId: 'p1' })).resolves.toMatchObject({
      success: false,
      status: 'dirty_state_unavailable',
      openTabIds: ['pcb1-extended-native-tab'],
    });
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

  it.each([
    ['activation_failed', { activationFails: true }],
    ['focused_document_mismatch', { focusedProject: 'a-different-project' }],
    ['save_failed', { saveThrows: true }],
  ])('blocks an unsafe native save: %s', async (status, flags) => {
    const { operations, callFirst } = fixture(flags);
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status });
    expect(
      callFirst.mock.calls.some(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toBe(false);
  });

  it('refuses unverified native close without falsely reporting success', async () => {
    const { operations, callFirst } = fixture({ nativeCloseReturnsFalse: true });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'native_close_unverified' });
    expect(
      callFirst.mock.calls.filter(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toHaveLength(1);
  });

  it('does not blindly retry a native close when delayed readback never confirms', async () => {
    const { operations, callFirst } = fixture({ closeReadbackDelay: 50 });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'close_readback_unverified' });
    expect(
      callFirst.mock.calls.filter(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toHaveLength(1);
  }, 10000);

  it.each([
    ['invalid_close_request', { projectId: 'p1', mode: 'unknown' }],
    ['active_project_mismatch', { projectId: 'p2', mode: 'save', confirmWrite: true }],
  ])('refuses bad close target: %s', async (status, input) => {
    const { operations, callFirst } = fixture();
    await expect(operations.close(input)).resolves.toMatchObject({ success: false, status });
    expect(
      callFirst.mock.calls.some(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toBe(false);
  });

  it('returns already_closed without invoking native close if no document is open', async () => {
    const { operations, callFirst } = fixture({
      tabs: [{ tabId: 'start', title: 'Start Page', data: { doctype: 'start' } }],
    });
    await expect(operations.close({ projectId: 'p1' })).resolves.toMatchObject({
      success: true,
      status: 'already_closed',
      closedTabs: [],
    });
    expect(
      callFirst.mock.calls.some(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toBe(false);
  });

  it('blocks saving panel documents without a tested stable native panel save API', async () => {
    const { operations, callFirst } = fixture({
      projectData: [{ panel: { uuid: 'panel1' } }],
      tabs: [
        { tabId: 'panel1-native-tab', title: 'Panel1', data: { pid: 'p1', creator: 'panel1' } },
      ],
    });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'panel_save_unsupported' });
    expect(
      callFirst.mock.calls.some(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toBe(false);
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

  // Captured from a real EasyEDA Pro 3.2.209 P1.Schematic tab. The native
  // schema has data-model-sheet-uuid but no creator field for schematic pages.
  const nativeSchematicTab = {
    tabId: 'sch1-extended-native-tab',
    title: 'P1.Schematic',
    data: {
      pid: 'p1',
      doctype: 1,
      creator: 'native-actor-not-the-page',
      'data-model-sheet-uuid': 'sch1',
    },
  };

  it('recognizes the real schematic page but refuses unsafe save-and-close until persisted', async () => {
    const { operations, callFirst } = fixture({
      focusedDocument: 'sch1',
      focusedDocumentType: 1,
      tabs: [{ tabId: 'start', title: 'Start Page', data: { doctype: -1 } }, nativeSchematicTab],
    });
    const opened = await operations.open({ projectId: 'p1' });
    expect(opened).toMatchObject({
      success: true,
      status: 'already_active',
      documents: expect.arrayContaining([
        { documentId: 'sch1', type: 'schematic', tabId: 'sch1-extended-native-tab' },
      ]),
    });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'schematic_persistence_unverified' });
    const names = callFirst.mock.calls.map(([paths]) => (paths as readonly string[])[0]);
    expect(names).not.toContain('sch_Document.save');
    expect(names).not.toContain('dmt_EditorControl.closeDocument');
  });

  it.each([
    ['wrong project', { pid: 'another' }, 'sch1-extended-native-tab'],
    ['wrong page UUID', { 'data-model-sheet-uuid': 'another' }, 'sch1-extended-native-tab'],
    ['missing page UUID', { 'data-model-sheet-uuid': undefined }, 'sch1-extended-native-tab'],
    ['PCB tab type', { doctype: 3 }, 'sch1-extended-native-tab'],
    ['string document type', { doctype: '1' }, 'sch1-extended-native-tab'],
    ['forged tab prefix', {}, 'unrelated-native-tab'],
  ])('refuses an untrusted schematic tab: %s', async (_, changes, tabId) => {
    const { operations, callFirst } = fixture({
      focusedDocument: 'sch1',
      focusedDocumentType: 1,
      tabs: [
        { tabId: 'start', title: 'Start Page', data: { doctype: -1 } },
        { ...nativeSchematicTab, tabId, data: { ...nativeSchematicTab.data, ...changes } },
      ],
    });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'unknown_document_tabs' });
    expect(callFirst.mock.calls.some(([paths]) => paths[0] === 'sch_Document.save')).toBe(false);
    expect(
      callFirst.mock.calls.some(([paths]) => paths[0] === 'dmt_EditorControl.closeDocument'),
    ).toBe(false);
  });

  it('refuses duplicate schematic tabs even when each has matching native identity', async () => {
    const { operations, callFirst } = fixture({
      focusedDocument: 'sch1',
      focusedDocumentType: 1,
      tabs: [
        nativeSchematicTab,
        { ...nativeSchematicTab, title: 'Other', tabId: 'sch1-another-native-tab' },
      ],
    });
    await expect(
      operations.close({ projectId: 'p1', mode: 'save', confirmWrite: true }),
    ).resolves.toMatchObject({ success: false, status: 'unknown_document_tabs' });
    expect(callFirst.mock.calls.some(([paths]) => paths[0] === 'sch_Document.save')).toBe(false);
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
