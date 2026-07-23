import type { ApiRuntime } from './api-runtime.js';

export interface PcbMutationOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  deletePrimitives(ids: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
}

export interface PcbMutationOperations {
  addZone(params: Record<string, unknown>): Promise<unknown>;
  modifyComponent(params: Record<string, unknown>): Promise<unknown>;
  deleteComponents(params: Record<string, unknown>): Promise<{
    success: boolean;
    deletedCount: number;
    deleted: string[];
    notFound: string[];
  }>;
}

export function createPcbMutationOperations({
  callFirst,
  deletePrimitives,
}: PcbMutationOperationDependencies): PcbMutationOperations {
  async function addZone(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['PCB_PrimitivePour.create', 'PCB_ComplexPolygon.create', 'pcb_PrimitivePour.create'],
      params.points,
      params.layer,
      params.netName,
      params.clearance,
    );
  }

  async function modifyComponent(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
      params.primitiveId,
      params.property,
    );
  }

  async function deleteComponents(params: Record<string, unknown>): Promise<{
    success: boolean;
    deletedCount: number;
    deleted: string[];
    notFound: string[];
  }> {
    const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
    const result = await deletePrimitives(ids);
    return {
      success: result.notFound.length === 0,
      deletedCount: result.deleted.length,
      deleted: result.deleted,
      notFound: result.notFound,
    };
  }

  return { addZone, modifyComponent, deleteComponents };
}
