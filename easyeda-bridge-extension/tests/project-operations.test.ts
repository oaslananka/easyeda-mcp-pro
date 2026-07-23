import { describe, expect, it, vi } from 'vitest';
import { createProjectOperations } from '../src/project-operations.js';

describe('project operations', () => {
  it('opens a project with the original path order and project id', async () => {
    const callFirst = vi.fn(async () => 'opened');
    const operations = createProjectOperations({ callFirst });

    await expect(operations.open({ projectId: 'project-1' })).resolves.toBe('opened');
    expect(callFirst).toHaveBeenCalledWith(
      ['dmt_Project.openProject', 'project.open'],
      'project-1',
    );
  });

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
