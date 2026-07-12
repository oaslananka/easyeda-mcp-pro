import { stableHash } from './stable.js';

export const SCHEMATIC_OPERATION_KINDS = [
  'placeComponent',
  'modifyComponent',
  'deletePrimitive',
  'addWire',
  'createLabel',
  'createPowerSymbol',
  'createText',
  'addNoConnect',
] as const;

export type SchematicOperationKind = (typeof SCHEMATIC_OPERATION_KINDS)[number];

export interface SchematicOperation {
  operationId: string;
  kind: SchematicOperationKind;
  input: Readonly<Record<string, unknown>>;
  targetPrimitiveIds?: readonly string[];
  order?: number;
}

export interface MutationResult {
  success: boolean;
  primitiveId?: string;
  createdPrimitiveIds?: readonly string[];
  modifiedPrimitiveIds?: readonly string[];
  deletedPrimitiveIds?: readonly string[];
  details?: Readonly<Record<string, unknown>>;
}

export interface OperationLogEntry {
  sequence: number;
  operation: SchematicOperation;
  groupPath: readonly string[];
  startedAt: string;
  completedAt: string;
  result: MutationResult;
}

const KIND_PRIORITY: Record<SchematicOperationKind, number> = {
  placeComponent: 10,
  modifyComponent: 20,
  addWire: 30,
  createLabel: 40,
  createPowerSymbol: 50,
  createText: 60,
  addNoConnect: 70,
  deletePrimitive: 80,
};

export function operationId(
  kind: SchematicOperationKind,
  input: Readonly<Record<string, unknown>>,
  index = 0,
): string {
  return `op_${stableHash({ kind, input, index }).slice(0, 16)}`;
}

export function deterministicOperations(
  operations: readonly SchematicOperation[],
): SchematicOperation[] {
  return operations
    .map((operation, originalIndex) => ({ operation, originalIndex }))
    .sort((left, right) => {
      const leftOrder = left.operation.order ?? KIND_PRIORITY[left.operation.kind];
      const rightOrder = right.operation.order ?? KIND_PRIORITY[right.operation.kind];
      return (
        leftOrder - rightOrder ||
        left.originalIndex - right.originalIndex ||
        left.operation.operationId.localeCompare(right.operation.operationId)
      );
    })
    .map(({ operation }) => operation);
}

export function changedPrimitiveIds(log: readonly OperationLogEntry[]): {
  created: string[];
  modified: string[];
  deleted: string[];
} {
  const created = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  for (const entry of log) {
    for (const id of entry.result.createdPrimitiveIds ?? []) created.add(id);
    if (entry.result.primitiveId && entry.operation.kind === 'placeComponent') {
      created.add(entry.result.primitiveId);
    }
    for (const id of entry.result.modifiedPrimitiveIds ?? []) modified.add(id);
    for (const id of entry.result.deletedPrimitiveIds ?? []) deleted.add(id);
  }
  return {
    created: [...created].sort(),
    modified: [...modified].sort(),
    deleted: [...deleted].sort(),
  };
}
