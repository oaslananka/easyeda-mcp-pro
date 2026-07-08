/**
 * Auto-sized section box layout for a cluster of already-placed schematic
 * components — the "cosmetic auto-layout" gap identified from real usage: a
 * hand-drawn section rectangle sized before all components were placed ends
 * up too small (components spill outside it) or misaligned (an empty-looking
 * box next to the part it's supposed to enclose).
 *
 * Scope, deliberately bounded: this computes a box from each component's
 * real pin extents (the only per-component geometry this bridge can query —
 * there is no symbol/body bounding-box API) plus a fixed padding allowance,
 * and unions the whole cluster. It does NOT attempt symbol-level
 * de-collision or net-label decluttering — those remain a manual review
 * item. It also does NOT attempt to resize the sheet/page frame (EasyEDA's
 * Width/Height title-block fields are documented read-only through this
 * bridge — see skills/easyeda-workflow/SKILL.md's set_title_block caveat);
 * page overflow is reported as an advisory warning only.
 *
 * @module
 */

import { type ToolContext } from '../tools/types.js';
import { fetchComponentPins } from '../tools/schematic-helpers.js';

export interface SectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RectangleSummary {
  primitiveId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Union of every candidate's pin coordinates, padded per-component to
 *  approximate body extent beyond the pins themselves, then padded again by
 *  `margin` for breathing room around the whole cluster. */
export async function computeSectionBounds(
  ctx: ToolContext,
  primitiveIds: string[],
  componentPadding: number,
  margin: number,
): Promise<SectionBounds | null> {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const primitiveId of primitiveIds) {
    const pins = await fetchComponentPins(ctx, primitiveId);
    for (const pin of pins) {
      minX = Math.min(minX, pin.x - componentPadding);
      minY = Math.min(minY, pin.y - componentPadding);
      maxX = Math.max(maxX, pin.x + componentPadding);
      maxY = Math.max(maxY, pin.y + componentPadding);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  };
}

function rectanglesOverlap(a: SectionBounds, b: RectangleSummary): boolean {
  if (
    typeof b.x !== 'number' ||
    typeof b.y !== 'number' ||
    typeof b.width !== 'number' ||
    typeof b.height !== 'number'
  ) {
    return false;
  }
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Best-effort: list every rectangle currently on the sheet (via the bridge's
 * `schematic.listRectangles`, added alongside this feature) and report which
 * ones the proposed section bounds would overlap. Advisory only — two
 * sections sharing an edge is often intentional, so this never blocks a
 * layout call, it only surfaces the overlap for the caller to judge.
 *
 * Caveat (live-verified 2026-07-09, see memory/easyeda_hotswap_getall_staleness.md):
 * the underlying getAll()-style bridge enumeration can miss primitives created
 * earlier in the same live session (confirmed for wires; unconfirmed but
 * plausible for rectangles too, since listRectangles uses the same pattern).
 * Treat an empty overlap list as advisory, not proof there's no overlap with
 * a rectangle created moments earlier in the same session.
 */
export async function findOverlappingRectangles(
  ctx: ToolContext,
  bounds: SectionBounds,
  excludePrimitiveIds: string[],
): Promise<RectangleSummary[]> {
  try {
    const result = await ctx.bridge.call<
      Record<string, never>,
      { total?: number; items?: RectangleSummary[] }
    >('schematic.listRectangles', {});
    const items = result?.items ?? [];
    const exclude = new Set(excludePrimitiveIds);
    return items.filter((r) => !exclude.has(r.primitiveId) && rectanglesOverlap(bounds, r));
  } catch {
    // listRectangles is best-effort (getAll() on a primitive type this bridge
    // doesn't otherwise enumerate) — degrade to "no overlap data" rather than fail.
    return [];
  }
}

/**
 * Best-effort: compare the proposed bounds against the sheet's reported page
 * size. Returns a warning string if the section would extend past the page,
 * or null if it fits (or the page size couldn't be determined). Purely
 * advisory — see module doc for why this never attempts to resize the page.
 */
export async function checkAgainstPageFrame(
  ctx: ToolContext,
  projectId: string,
  bounds: SectionBounds,
): Promise<string | null> {
  try {
    const result = await ctx.bridge.call<{ projectId?: string }, unknown>(
      'schematic.getSheetInfo',
      { projectId },
    );
    const root =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    const current =
      root.currentPage && typeof root.currentPage === 'object' && !Array.isArray(root.currentPage)
        ? (root.currentPage as Record<string, unknown>)
        : root;
    const readNumber = (keys: string[]): number | undefined => {
      for (const key of keys) {
        const value = current[key] ?? root[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return undefined;
    };
    const width = readNumber(['width', 'pageWidth', 'paperWidth', 'w']);
    const height = readNumber(['height', 'pageHeight', 'paperHeight', 'h']);
    if (width === undefined || height === undefined) return null;

    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    if (bounds.x < 0 || bounds.y < 0 || right > width || bottom > height) {
      return (
        `Section bounds (x:${bounds.x.toFixed(0)}, y:${bounds.y.toFixed(0)}, ` +
        `right:${right.toFixed(0)}, bottom:${bottom.toFixed(0)}) extend past the reported page ` +
        `size (${width}x${height}, origin assumed at 0,0 — approximate). This bridge cannot ` +
        'resize the page frame (Width/Height are read-only through this API); reposition the ' +
        'section or resize the page manually in EasyEDA Pro.'
      );
    }
    return null;
  } catch {
    return null;
  }
}
