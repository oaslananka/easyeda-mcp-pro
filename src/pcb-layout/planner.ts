import { createHash } from 'node:crypto';
import type {
  BoardBox,
  ComponentGroupPlacementInput,
  ComponentGroupPlacementPlan,
  LayoutIssue,
  NativePcbBoardBox,
  NativePcbPoint,
  NativePcbRect,
  PlannedComponentPlacement,
  RectMm,
  RoutePathInput,
  RoutePathPlan,
} from './types.js';

const PCB_MIL_TO_MM = 0.0254;

function pcbMilToMm(value: number): number {
  return value * PCB_MIL_TO_MM;
}

function mmToPcbMil(value: number): number {
  return value / PCB_MIL_TO_MM;
}

function txId(prefix: string, payload: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
}

function issue(
  code: LayoutIssue['code'],
  severity: LayoutIssue['severity'],
  message: string,
  remediationHint: string,
  details?: Record<string, unknown>,
): LayoutIssue {
  return { code, severity, message, remediationHint, details };
}

function rectsOverlap(a: RectMm, b: RectMm): boolean {
  return (
    a.x < b.x + b.widthMm &&
    a.x + a.widthMm > b.x &&
    a.y < b.y + b.heightMm &&
    a.y + a.heightMm > b.y
  );
}

function rectInsideBoard(rect: RectMm, board: BoardBox): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.widthMm <= board.widthMm &&
    rect.y + rect.heightMm <= board.heightMm
  );
}

function pointInsideBoard(point: NativePcbPoint, board: NativePcbBoardBox): boolean {
  return (
    point.x >= board.minX && point.x <= board.maxX && point.y >= board.minY && point.y <= board.maxY
  );
}

function inflate(rect: RectMm, amount: number): RectMm {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    widthMm: rect.widthMm + amount * 2,
    heightMm: rect.heightMm + amount * 2,
    name: rect.name,
  };
}

function distance(a: NativePcbPoint, b: NativePcbPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function routeLengthMil(points: NativePcbPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    total += distance(previous, current);
  }
  return total;
}

/** Exact line-segment / axis-aligned rectangle intersection, including edge contact. */
function segmentIntersectsRect(a: NativePcbPoint, b: NativePcbPoint, rect: NativePcbRect): boolean {
  let enter = 0;
  let exit = 1;
  const axes: Array<[number, number, number, number]> = [
    [a.x, b.x - a.x, rect.x, rect.x + rect.width],
    [a.y, b.y - a.y, rect.y, rect.y + rect.height],
  ];
  for (const [start, delta, lower, upper] of axes) {
    const min = Math.min(lower, upper);
    const max = Math.max(lower, upper);
    if (delta === 0) {
      if (start < min || start > max) return false;
      continue;
    }
    const t1 = (min - start) / delta;
    const t2 = (max - start) / delta;
    enter = Math.max(enter, Math.min(t1, t2));
    exit = Math.min(exit, Math.max(t1, t2));
    if (enter > exit) return false;
  }
  return true;
}

/** Conservative axis-aligned bounds of a footprint after rotating about its centre. */
function rotatedFootprintSize(widthMm: number, heightMm: number, rotation: number) {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  // Exact quarter-turns should not acquire floating-point phantom overhang.
  const c = cos < 1e-12 ? 0 : cos;
  const s = sin < 1e-12 ? 0 : sin;
  return { widthMm: widthMm * c + heightMm * s, heightMm: widthMm * s + heightMm * c };
}

function invalidBoard(board: BoardBox): boolean {
  return board.widthMm <= 0 || board.heightMm <= 0;
}

/** Create a preview/apply plan for placing a group of components on a grid. */
export function planComponentGroupPlacement(
  input: ComponentGroupPlacementInput,
): ComponentGroupPlacementPlan {
  const mode = input.mode ?? 'preview';
  const layer = input.layer ?? 1;
  const columns = Math.max(1, input.columns ?? input.components.length);
  const spacing = input.spacingMm ?? 1.5;
  const minSpacing = input.minSpacingMm ?? 0.25;
  const issues: LayoutIssue[] = [];
  const placements: PlannedComponentPlacement[] = [];

  if (invalidBoard(input.board)) {
    issues.push(
      issue(
        'LAYOUT_INVALID_BOARD',
        'error',
        'Board dimensions must be positive',
        'Provide valid board width and height before planning placement.',
        { board: input.board },
      ),
    );
  }

  input.components.forEach((component, index) => {
    if (!component.ref || component.widthMm <= 0 || component.heightMm <= 0) {
      issues.push(
        issue(
          'LAYOUT_INVALID_COMPONENT',
          'error',
          `Component ${component.ref || index} has invalid dimensions or reference`,
          'Provide component ref, width, and height in millimeters.',
          { component },
        ),
      );
      return;
    }

    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = input.anchor.x + col * (component.widthMm + spacing);
    const y = input.anchor.y + row * (component.heightMm + spacing);
    const rotated = rotatedFootprintSize(
      component.widthMm,
      component.heightMm,
      component.rotation ?? 0,
    );
    const bbox = {
      x: x - rotated.widthMm / 2,
      y: y - rotated.heightMm / 2,
      widthMm: rotated.widthMm,
      heightMm: rotated.heightMm,
      name: component.ref,
    };
    const placement = {
      ref: component.ref,
      primitiveId: component.primitiveId,
      footprint: component.footprint,
      x,
      y,
      rotation: component.rotation ?? 0,
      layer,
      widthMm: component.widthMm,
      heightMm: component.heightMm,
      bbox,
    };

    if (!rectInsideBoard(bbox, input.board)) {
      issues.push(
        issue(
          'LAYOUT_COMPONENT_OUTSIDE_BOARD',
          'error',
          `Component ${component.ref} would be outside the board`,
          'Move the anchor, reduce spacing, increase board size, or reduce the component group size.',
          { ref: component.ref, bbox, board: input.board },
        ),
      );
    }

    for (const keepout of input.keepouts ?? []) {
      if (rectsOverlap(bbox, keepout)) {
        issues.push(
          issue(
            'LAYOUT_COMPONENT_IN_KEEPOUT',
            'error',
            `Component ${component.ref} overlaps keepout ${keepout.name ?? ''}`.trim(),
            'Move the component group away from keepout regions.',
            { ref: component.ref, keepout, bbox },
          ),
        );
      }
    }

    for (const previous of placements) {
      if (rectsOverlap(inflate(previous.bbox, minSpacing), inflate(bbox, minSpacing))) {
        issues.push(
          issue(
            'LAYOUT_COMPONENT_COLLISION',
            'error',
            `Component ${component.ref} collides with ${previous.ref}`,
            'Increase placement spacing or change grid columns/anchor.',
            { ref: component.ref, otherRef: previous.ref, minSpacingMm: minSpacing },
          ),
        );
      }
    }

    if (!component.primitiveId) {
      issues.push(
        issue(
          'LAYOUT_COMPONENT_NOT_ON_BOARD',
          'error',
          `Component ${component.ref} has no existing PCB primitive ID`,
          'Sync the component from the schematic into the PCB first, then pass its primitiveId for placement.',
          { ref: component.ref },
        ),
      );
    }

    placements.push(placement);
  });

  const operations = placements
    .filter((placement) => Boolean(placement.primitiveId))
    .map((placement) => ({
      method: 'pcb.modifyComponent',
      params: {
        primitiveId: placement.primitiveId as string,
        property: {
          x: placement.x,
          y: placement.y,
          rotation: placement.rotation,
          layer: placement.layer,
        },
      },
    }));
  const blocked = issues.some((i) => i.severity === 'error');

  return {
    transactionId: txId('layout_place', { input, placements }),
    projectId: input.projectId ?? '',
    mode,
    applied: false,
    blocked,
    placements,
    operations,
    issues,
    summary: blocked
      ? `Placement plan blocked by ${issues.filter((i) => i.severity === 'error').length} error(s).`
      : `Placement plan ready for ${placements.length} component(s).`,
  };
}

/** Create a preview/apply plan for a constrained routed path. */
export function planRoutePath(input: RoutePathInput): RoutePathPlan {
  const mode = input.mode ?? 'preview';
  const issues: LayoutIssue[] = [];
  const lengthMm = pcbMilToMm(routeLengthMil(input.waypoints));

  if (input.waypoints.length < 2) {
    issues.push(
      issue(
        'LAYOUT_PATH_TOO_SHORT',
        'error',
        'Route path requires at least two waypoints',
        'Provide start and end waypoints for the route path.',
        { waypointCount: input.waypoints.length },
      ),
    );
  }

  if (input.widthMm <= 0) {
    issues.push(
      issue(
        'LAYOUT_TRACE_WIDTH_TOO_SMALL',
        'error',
        'Trace width must be positive',
        'Provide a positive trace width in millimeters.',
        { widthMm: input.widthMm },
      ),
    );
  } else if (input.minWidthMm !== undefined && input.widthMm < input.minWidthMm) {
    issues.push(
      issue(
        'LAYOUT_TRACE_WIDTH_TOO_SMALL',
        'error',
        `Trace width ${input.widthMm}mm is below required ${input.minWidthMm}mm`,
        'Increase trace width or lower the constraint only after electrical/thermal review.',
        { widthMm: input.widthMm, minWidthMm: input.minWidthMm },
      ),
    );
  }

  if (input.maxLengthMm !== undefined && lengthMm > input.maxLengthMm) {
    issues.push(
      issue(
        'LAYOUT_PATH_TOO_LONG',
        'warning',
        `Route length ${Number(lengthMm.toFixed(3))}mm exceeds maximum ${input.maxLengthMm}mm`,
        'Shorten the route or relax the maximum length constraint if acceptable.',
        { pathLengthMm: lengthMm, maxLengthMm: input.maxLengthMm },
      ),
    );
  }

  if (input.board) {
    for (const point of input.waypoints) {
      if (!pointInsideBoard(point, input.board)) {
        issues.push(
          issue(
            'LAYOUT_PATH_OUTSIDE_BOARD',
            'error',
            'Route waypoint is outside the board',
            'Move all route waypoints inside the board outline.',
            { point, board: input.board },
          ),
        );
      }
    }
  }

  for (let i = 1; i < input.waypoints.length; i += 1) {
    const a = input.waypoints[i - 1];
    const b = input.waypoints[i];
    if (!a || !b) continue;
    // Route width matters: the copper edge can enter a keepout even if the
    // track centreline remains outside it. Keepout coordinates are native mil.
    const halfWidthMil = mmToPcbMil(Math.max(0, input.widthMm)) / 2;
    for (const keepout of input.keepouts ?? []) {
      const expanded = {
        ...keepout,
        x: keepout.x - halfWidthMil,
        y: keepout.y - halfWidthMil,
        width: keepout.width + 2 * halfWidthMil,
        height: keepout.height + 2 * halfWidthMil,
      };
      if (segmentIntersectsRect(a, b, expanded)) {
        issues.push(
          issue(
            'LAYOUT_PATH_IN_KEEPOUT',
            'error',
            `Route crosses keepout ${keepout.name ?? ''}`.trim(),
            'Add waypoints around keepout regions or change the routing layer.',
            { keepout, segment: [a, b] },
          ),
        );
      }
    }
  }

  const operations = [
    {
      method: 'pcb.addTrack',
      params: {
        points: input.waypoints,
        layer: input.layer,
        width: mmToPcbMil(input.widthMm),
        netName: input.netName,
      },
    },
  ];
  const blocked = issues.some((i) => i.severity === 'error');

  return {
    transactionId: txId('layout_route', { input, lengthMm }),
    projectId: input.projectId ?? '',
    mode,
    applied: false,
    blocked,
    netName: input.netName,
    layer: input.layer,
    widthMm: input.widthMm,
    pathLengthMm: Number(lengthMm.toFixed(4)),
    operations,
    issues,
    summary: blocked
      ? `Route plan blocked by ${issues.filter((i) => i.severity === 'error').length} error(s).`
      : `Route plan ready for net ${input.netName}; length ${Number(lengthMm.toFixed(3))}mm.`,
  };
}
