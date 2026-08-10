import type { ApiRuntime } from './api-runtime.js';

export interface PcbMutationOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  deletePrimitives(ids: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
}

const PCB_COMPONENT_TRANSFORM_FIELDS = new Set(['layer', 'x', 'y', 'rotation', 'primitiveLock']);

function validatedComponentTransformProperty(value: unknown): Record<string, number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PCB component transform property must be an object');
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, number | boolean> = {};
  for (const [key, fieldValue] of Object.entries(input)) {
    if (!PCB_COMPONENT_TRANSFORM_FIELDS.has(key)) {
      throw new TypeError(`Unsupported PCB component transform field: ${key}`);
    }
    if (key === 'primitiveLock') {
      if (typeof fieldValue !== 'boolean') {
        throw new TypeError('PCB component primitiveLock must be a boolean');
      }
      output[key] = fieldValue;
      continue;
    }
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
      throw new TypeError(`PCB component ${key} must be a finite number`);
    }
    if (key === 'layer' && fieldValue !== 1 && fieldValue !== 2) {
      throw new TypeError('PCB component layer must be 1 (top) or 2 (bottom)');
    }
    output[key] = fieldValue;
  }
  if (Object.keys(output).length === 0) {
    throw new TypeError('PCB component transform must change at least one supported field');
  }
  return output;
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

async function rejectUnverifiedZoneCreation(_params: Record<string, unknown>): Promise<unknown> {
  throw new Error(
    'PCB copper-zone creation is unavailable until the complete native contract is verified.',
  );
}

export function createPcbMutationOperations({
  callFirst,
  deletePrimitives,
}: PcbMutationOperationDependencies): PcbMutationOperations {
  async function modifyComponent(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
      params.primitiveId,
      validatedComponentTransformProperty(params.property),
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

  return { addZone: rejectUnverifiedZoneCreation, modifyComponent, deleteComponents };
}
