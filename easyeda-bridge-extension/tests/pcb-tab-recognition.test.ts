import { describe, expect, it, vi } from 'vitest';
import { createProjectOperations } from '../src/project-operations.js';

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

function operationsWithTabs(tabs: unknown[]) {
  const callFirst = vi.fn(async (paths: readonly string[]) => {
    if (paths[0] === 'dmt_Project.getCurrentProjectInfo') return project;
    if (paths[0] === 'dmt_EditorControl.getSplitScreenTree') return { tabs };
    throw new Error(`unexpected native call ${paths[0]}`);
  });
  return createProjectOperations({ callFirst });
}

async function pcbTabId(tabs: unknown[]): Promise<string | null | undefined> {
  const result = (await operationsWithTabs(tabs).open({ projectId: 'p1' })) as {
    documents: Array<{ documentId: string; tabId: string | null }>;
  };
  return result.documents.find((doc) => doc.documentId === 'pcb1')?.tabId;
}

describe('EasyEDA Pro 4.x PCB tab recognition', () => {
  it('recognizes a PCB tab by its exact `<pcb>@<project>` id when creator is the user id', async () => {
    await expect(
      pcbTabId([
        startTab,
        { tabId: 'pcb1@p1', title: 'PCB', data: { doctype: 3, pid: 'p1', creator: 'user-9' } },
      ]),
    ).resolves.toBe('pcb1@p1');
  });

  it('still recognizes the 3.2.209 shape where creator is the document id', async () => {
    await expect(
      pcbTabId([
        startTab,
        { tabId: 'pcb1-native-tab', title: 'PCB1', data: { pid: 'p1', creator: 'pcb1' } },
      ]),
    ).resolves.toBe('pcb1-native-tab');
  });

  it('does not accept a prefix-only id, another project or a non-PCB doctype', async () => {
    await expect(
      pcbTabId([
        startTab,
        { tabId: 'pcb1@p1-copy', title: 'PCB', data: { doctype: 3, pid: 'p1', creator: 'user-9' } },
        { tabId: 'pcb1@p2', title: 'PCB', data: { doctype: 3, pid: 'p1', creator: 'user-9' } },
      ]),
    ).resolves.toBeNull();
    await expect(
      pcbTabId([
        startTab,
        { tabId: 'pcb1@p1', title: 'PCB', data: { doctype: 1, pid: 'p1', creator: 'user-9' } },
      ]),
    ).resolves.toBeNull();
  });
});
