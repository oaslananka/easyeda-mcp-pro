import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';

export type PrimitiveIdExtractor = (value: unknown) => string;

export interface PcbWriteOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  extractPrimitiveId: PrimitiveIdExtractor;
  createBridgeError: BridgeErrorFactory;
}

export interface PcbWriteOperations {
  addTrack(params: Record<string, unknown>): Promise<unknown>;
  addText(params: Record<string, unknown>): Promise<unknown>;
  addSilkscreenLine(params: Record<string, unknown>): Promise<unknown>;
  addVia(params: Record<string, unknown>): Promise<unknown>;
}

export function createPcbWriteOperations({
  callFirst,
  extractPrimitiveId,
  createBridgeError,
}: PcbWriteOperationDependencies): PcbWriteOperations {
  async function addTrack(params: Record<string, unknown>): Promise<unknown> {
    // PCB_PrimitivePolyline.create's real argument order could not be
    // determined live. PCB_PrimitiveLine.create was confirmed as
    // create(net, layer, startX, startY, endX, endY, lineWidth, locked).
    const points: Array<{ x: number; y: number }> = Array.isArray(params.points)
      ? params.points
      : [];
    if (points.length < 2) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'pcb.addTrack requires at least 2 points',
        'Provide a points array with at least a start and end coordinate.',
      );
    }

    const createdIds: string[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const created = await callFirst(
        ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
        params.netName,
        params.layer,
        start.x,
        start.y,
        end.x,
        end.y,
        params.width,
        false,
      );
      createdIds.push(extractPrimitiveId(created));
    }

    return { primitiveId: createdIds[0], primitiveIds: createdIds };
  }

  async function addText(params: Record<string, unknown>): Promise<unknown> {
    // PCB_PrimitiveString.create was live-confirmed as:
    // create(layer, x, y, text, fontFamily, fontSize, lineWidth, alignMode,
    // rotation, reverse, expansion, mirror, primitiveLock).
    return callFirst(
      ['PCB_PrimitiveString.create', 'pcb_PrimitiveString.create'],
      params.layer,
      params.x,
      params.y,
      params.text,
      params.fontFamily ?? 'NotoSansMonoCJKsc-Regular',
      params.fontSize ?? 1,
      params.lineWidth ?? 0.15,
      params.alignMode ?? 0,
      params.rotation ?? 0,
      params.reverse ?? false,
      params.expansion ?? 0,
      params.mirror ?? false,
      params.locked ?? false,
    );
  }

  async function addSilkscreenLine(params: Record<string, unknown>): Promise<unknown> {
    // Reuse PCB_PrimitiveLine.create with an empty net and a non-copper layer
    // so the result remains decorative rather than electrical.
    return callFirst(
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      '',
      params.layer,
      params.startX,
      params.startY,
      params.endX,
      params.endY,
      params.lineWidth ?? 0.2,
      false,
    );
  }

  async function addVia(params: Record<string, unknown>): Promise<unknown> {
    // PCB_PrimitiveVia.create was live-confirmed as:
    // create(net, x, y, holeDiameter, diameter, viaType,
    // designRuleBlindViaName, locked, solderMaskExpansion).
    return callFirst(
      ['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'],
      params.netName,
      params.x,
      params.y,
      params.holeSize,
      params.outerDiameter,
      0,
      '',
      false,
      undefined,
    );
  }

  return {
    addTrack,
    addText,
    addSilkscreenLine,
    addVia,
  };
}
