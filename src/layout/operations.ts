import {
  candidateGrid,
  clampRect,
  compareIds,
  inflateRect,
  rectCenter,
  rectFromCenter,
  rectInsideRect,
  rectsOverlap,
  segmentIntersectsRect,
} from './geometry.js';
import type {
  AlignOptions,
  CompactLayoutOptions,
  DistributeOptions,
  LabelOptimizationOptions,
  LayoutLabel,
  LayoutPlacement,
  LayoutPoint,
  LayoutWire,
  ResolveOverlapOptions,
} from './types.js';

function movedPlacement(
  placement: LayoutPlacement,
  x: number,
  y: number,
  reason: string,
): LayoutPlacement {
  return {
    ...placement,
    x,
    y,
    bbox: rectFromCenter({ x, y }, placement.width, placement.height, placement.componentId),
    reason,
  };
}

function selectedPlacements(
  placements: readonly LayoutPlacement[],
  componentIds?: readonly string[],
): LayoutPlacement[] {
  const selected = componentIds ? new Set(componentIds) : undefined;
  return placements.filter((placement) => !selected || selected.has(placement.componentId));
}

export function alignComponents(
  placements: readonly LayoutPlacement[],
  options: AlignOptions,
): LayoutPlacement[] {
  const selected = selectedPlacements(placements, options.componentIds);
  if (selected.length === 0) return placements.map((placement) => ({ ...placement, bbox: { ...placement.bbox } }));
  const coordinate = options.axis === 'x' ? 'x' : 'y';
  const value =
    options.value ??
    selected.reduce((sum, placement) => sum + placement[coordinate], 0) / selected.length;
  const selectedIds = new Set(selected.map((placement) => placement.componentId));
  return placements.map((placement) => {
    if (!selectedIds.has(placement.componentId) || placement.locked) {
      return { ...placement, bbox: { ...placement.bbox } };
    }
    return movedPlacement(
      placement,
      options.axis === 'x' ? value : placement.x,
      options.axis === 'y' ? value : placement.y,
      `aligned-${options.axis}`,
    );
  });
}

export function distributeComponents(
  placements: readonly LayoutPlacement[],
  options: DistributeOptions,
): LayoutPlacement[] {
  const coordinate = options.axis === 'x' ? 'x' : 'y';
  const selected = selectedPlacements(placements, options.componentIds).sort(
    (a, b) => a[coordinate] - b[coordinate] || compareIds(a.componentId, b.componentId),
  );
  if (selected.length < 2) return placements.map((placement) => ({ ...placement, bbox: { ...placement.bbox } }));
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (!first || !last) return placements.map((placement) => ({ ...placement, bbox: { ...placement.bbox } }));
  const start = options.start ?? first[coordinate];
  const end = options.end ?? last[coordinate];
  const step = (end - start) / (selected.length - 1);
  const targetById = new Map(
    selected.map((placement, index) => [placement.componentId, start + index * step]),
  );
  return placements.map((placement) => {
    const target = targetById.get(placement.componentId);
    if (target === undefined || placement.locked) return { ...placement, bbox: { ...placement.bbox } };
    return movedPlacement(
      placement,
      options.axis === 'x' ? target : placement.x,
      options.axis === 'y' ? target : placement.y,
      `distributed-${options.axis}`,
    );
  });
}

function firstAvailableCenter(
  placement: LayoutPlacement,
  bounds: CompactLayoutOptions['bounds'],
  occupied: readonly LayoutPlacement[],
  spacing: number,
): { x: number; y: number } | undefined {
  const candidateBounds = {
    x: bounds.x + placement.width / 2,
    y: bounds.y + placement.height / 2,
    width: Math.max(0, bounds.width - placement.width),
    height: Math.max(0, bounds.height - placement.height),
  };
  const step = Math.max(1, spacing);
  for (const center of candidateGrid(candidateBounds, step)) {
    const bbox = rectFromCenter(center, placement.width, placement.height, placement.componentId);
    if (occupied.every((other) => !rectsOverlap(bbox, other.bbox, spacing))) return center;
  }
  return undefined;
}

export function compactLayout(
  placements: readonly LayoutPlacement[],
  options: CompactLayoutOptions,
): LayoutPlacement[] {
  const spacing = Math.max(0, options.spacing ?? 12);
  const lockedIds = new Set(options.lockedComponentIds ?? []);
  const ordered = [...placements].sort((a, b) => compareIds(a.componentId, b.componentId));
  const resultById = new Map<string, LayoutPlacement>();
  const occupied: LayoutPlacement[] = [];
  for (const placement of ordered.filter((item) => item.locked || lockedIds.has(item.componentId))) {
    const clone = { ...placement, bbox: { ...placement.bbox }, locked: true };
    resultById.set(clone.componentId, clone);
    occupied.push(clone);
  }
  for (const placement of ordered) {
    if (resultById.has(placement.componentId)) continue;
    const center = firstAvailableCenter(placement, options.bounds, occupied, spacing);
    const next = center
      ? movedPlacement(placement, center.x, center.y, 'compacted')
      : { ...placement, bbox: { ...placement.bbox } };
    resultById.set(next.componentId, next);
    occupied.push(next);
  }
  return placements.map((placement) => resultById.get(placement.componentId) ?? placement);
}

function placementFits(
  bbox: LayoutPlacement['bbox'],
  occupied: readonly LayoutPlacement[],
  bounds: ResolveOverlapOptions['bounds'],
  keepouts: readonly ResolveOverlapOptions['bounds'][],
  spacing: number,
): boolean {
  return (
    rectInsideRect(bbox, bounds) &&
    keepouts.every((keepout) => !rectsOverlap(bbox, keepout, spacing)) &&
    occupied.every((placement) => !rectsOverlap(bbox, placement.bbox, spacing))
  );
}

export function resolveOverlaps(
  placements: readonly LayoutPlacement[],
  options: ResolveOverlapOptions,
): LayoutPlacement[] {
  const spacing = Math.max(0, options.spacing ?? 8);
  const maxIterations = Math.max(1, options.maxIterations ?? 20_000);
  const lockedIds = new Set(options.lockedComponentIds ?? []);
  const keepouts = options.keepouts ?? [];
  const resultById = new Map<string, LayoutPlacement>();
  const occupied: LayoutPlacement[] = [];
  const ordered = [...placements].sort(
    (a, b) =>
      Number(!(a.locked || lockedIds.has(a.componentId))) -
        Number(!(b.locked || lockedIds.has(b.componentId))) ||
      compareIds(a.componentId, b.componentId),
  );
  let iterations = 0;

  for (const placement of ordered) {
    const locked = placement.locked || lockedIds.has(placement.componentId);
    let next = { ...placement, bbox: { ...placement.bbox }, locked };
    if (!locked && !placementFits(next.bbox, occupied, options.bounds, keepouts, spacing)) {
      const centerBounds = {
        x: options.bounds.x + placement.width / 2,
        y: options.bounds.y + placement.height / 2,
        width: Math.max(0, options.bounds.width - placement.width),
        height: Math.max(0, options.bounds.height - placement.height),
      };
      const step = Math.max(1, spacing);
      for (const candidate of candidateGrid(centerBounds, step)) {
        iterations += 1;
        if (iterations > maxIterations) break;
        const bbox = rectFromCenter(
          candidate,
          placement.width,
          placement.height,
          placement.componentId,
        );
        if (placementFits(bbox, occupied, options.bounds, keepouts, spacing)) {
          next = movedPlacement(placement, candidate.x, candidate.y, 'overlap-resolved');
          break;
        }
      }
    }
    resultById.set(next.componentId, next);
    occupied.push(next);
  }
  return placements.map((placement) => resultById.get(placement.componentId) ?? placement);
}

function labelHitsWire(label: LayoutLabel, wires: readonly LayoutWire[]): boolean {
  return wires.some((wire) => {
    for (let index = 1; index < wire.points.length; index += 1) {
      const start = wire.points[index - 1];
      const end = wire.points[index];
      if (start && end && segmentIntersectsRect(start, end, label)) return true;
    }
    return false;
  });
}

export function optimizeLabels(
  labels: readonly LayoutLabel[],
  placements: readonly LayoutPlacement[],
  wires: readonly LayoutWire[],
  options: LabelOptimizationOptions,
): LayoutLabel[] {
  const clearance = Math.max(0, options.clearance ?? 4);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 24);
  const accepted: LayoutLabel[] = [];
  const offsets: LayoutPoint[] = [{ x: 0, y: 0 }];
  for (let ring = 1; ring <= Math.ceil(maxAttempts / 8); ring += 1) {
    const distance = ring * Math.max(1, clearance);
    offsets.push(
      { x: distance, y: 0 },
      { x: -distance, y: 0 },
      { x: 0, y: distance },
      { x: 0, y: -distance },
      { x: distance, y: distance },
      { x: -distance, y: distance },
      { x: distance, y: -distance },
      { x: -distance, y: -distance },
    );
  }

  for (const original of [...labels].sort((a, b) => compareIds(a.id, b.id))) {
    let chosen = clampRect(original, options.bounds) as LayoutLabel;
    for (const offset of offsets.slice(0, maxAttempts)) {
      const candidate = clampRect(
        { ...original, x: original.x + offset.x, y: original.y + offset.y },
        options.bounds,
      ) as LayoutLabel;
      const componentCollision = placements.some((placement) =>
        rectsOverlap(candidate, inflateRect(placement.bbox, clearance)),
      );
      const labelCollision = accepted.some((label) => rectsOverlap(candidate, label, clearance));
      if (!componentCollision && !labelCollision && !labelHitsWire(candidate, wires)) {
        chosen = candidate;
        break;
      }
    }
    accepted.push(chosen);
  }
  const byId = new Map(accepted.map((label) => [label.id, label]));
  return labels.map((label) => byId.get(label.id) ?? label);
}

export function placementCenter(placement: LayoutPlacement): LayoutPoint {
  return rectCenter(placement.bbox);
}
