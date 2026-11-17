import { describe, expect, it, vi } from 'vitest';
import { readNativeRemoteActiveProject } from '../src/remote-active-project.js';

describe('Hosted Cloud native project/document focus', () => {
  const project = { uuid: 'project-001', friendlyName: 'My PCB', name: 'internal-project' };
  const document = {
    uuid: 'pcb-a',
    parentProjectUuid: 'project-001',
    documentType: 3,
  };
  function runtime(p: unknown = project, d: unknown = document) {
    return {
      dmt_Project: { getCurrentProjectInfo: vi.fn(async () => p) },
      dmt_SelectControl: { getCurrentDocumentInfo: vi.fn(async () => d) },
    };
  }

  it('returns authoritative focused PCB and its project UUID instead of window title or URL', async () => {
    await expect(readNativeRemoteActiveProject(runtime())).resolves.toEqual({
      projectId: 'project-001',
      documentId: 'pcb-a',
      projectName: 'My PCB',
      documentType: 'pcb',
    });
  });

  it('distinguishes two documents in the same project by their document UUID', async () => {
    const first = await readNativeRemoteActiveProject(runtime());
    const second = await readNativeRemoteActiveProject(
      runtime(project, {
        ...document,
        uuid: 'pcb-b',
      }),
    );
    expect(first?.projectId).toBe(second?.projectId);
    expect(first?.documentId).not.toBe(second?.documentId);
  });

  it('recognizes the schematic page document type without treating a footprint as a PCB', async () => {
    await expect(
      readNativeRemoteActiveProject(runtime(project, { ...document, documentType: 1 })),
    ).resolves.toMatchObject({ documentType: 'schematic' });
    await expect(
      readNativeRemoteActiveProject(runtime(project, { ...document, documentType: 4 })),
    ).resolves.toBeUndefined();
  });

  it('fails closed if the focused document belongs to another project', async () => {
    await expect(
      readNativeRemoteActiveProject(
        runtime(project, {
          ...document,
          parentProjectUuid: 'project-002',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed for missing UUIDs, preview APIs, or a native exception', async () => {
    await expect(
      readNativeRemoteActiveProject(runtime({ name: 'window title' })),
    ).resolves.toBeUndefined();
    await expect(
      readNativeRemoteActiveProject(runtime(project, { ...document, uuid: '' })),
    ).resolves.toBeUndefined();
    await expect(
      readNativeRemoteActiveProject({ dmt_Project: {}, dmt_SelectControl: {} }),
    ).resolves.toBeUndefined();
    await expect(
      readNativeRemoteActiveProject({
        dmt_Project: {
          getCurrentProjectInfo: async () => {
            throw new Error('beta unavailable');
          },
        },
        dmt_SelectControl: { getCurrentDocumentInfo: async () => document },
      }),
    ).resolves.toBeUndefined();
  });

  it('reads older uppercase native aliases when the lowercase API is absent', async () => {
    const source = {
      DMT_Project: { getCurrentProjectInfo: async () => project },
      DMT_SelectControl: { getCurrentDocumentInfo: async () => document },
    };
    await expect(readNativeRemoteActiveProject(source)).resolves.toMatchObject({
      projectId: 'project-001',
      documentId: 'pcb-a',
    });
  });
});
