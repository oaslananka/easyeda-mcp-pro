import type { ApiRuntime } from './api-runtime.js';

export interface ProjectOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
}

export interface ProjectOperations {
  open(params: Record<string, unknown>): Promise<unknown>;
  save(params: Record<string, unknown>): Promise<unknown>;
  export(params: Record<string, unknown>): Promise<unknown>;
}

export function createProjectOperations({
  callFirst,
}: ProjectOperationDependencies): ProjectOperations {
  async function open(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(['dmt_Project.openProject', 'project.open'], params.projectId);
  }

  async function save(_params: Record<string, unknown>): Promise<unknown> {
    return callFirst([
      'dmt_Workspace.saveAll',
      'dmt_Workspace.saveActiveDocument',
      'sch_Document.save',
      'pcb_Document.save',
      'pnl_Document.save',
    ]);
  }

  async function exportProject(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['PCB_ManufactureData.getManufactureData', 'SCH_ManufactureData.getExportDocumentFile'],
      params,
    );
  }

  return { open, save, export: exportProject };
}
