/**
 * Generic wire-stub generator for schematic workflow templates.
 *
 * The NE555 template was the first workflow to include visible wire stubs, but
 * they were hand-coded with hardcoded pixel offsets.  This module provides a
 * reusable, data-driven generator that any template can call: supply the
 * anchor, a list of component pin descriptors (position relative to anchor,
 * direction, net), and it produces the `WorkflowWireInput[]` array the
 * planner expects.
 *
 * Stubs are always axis-aligned (horizontal or vertical) per EasyEDA's
 * constraint that diagonal wires are rejected.
 *
 * @module
 */

import type { WorkflowWireInput } from './types.js';

/** Which direction the wire stub extends from the pin. */
export type StubDirection = 'left' | 'right' | 'up' | 'down';

/** One pin on a placed component that needs a visible wire stub. */
export interface PinStubDescriptor {
  /** Component reference designator (for the wire's role label). */
  ref: string;
  /** Pin number / identifier (for the wire's role label). */
  pin: string;
  /** Net name the stub belongs to. */
  netName: string;
  /** Pin's absolute X position on the schematic canvas. */
  x: number;
  /** Pin's absolute Y position on the schematic canvas. */
  y: number;
  /** Direction the wire stub extends from the pin (default: 'right'). */
  direction?: StubDirection;
  /** Stub length in schematic units (default: 18). */
  length?: number;
}

/** Configuration for the generic wire-stub generator. */
export interface WireStubGeneratorOptions {
  /** Default stub length when not specified per-pin. */
  defaultLength?: number;
  /** Default wire line width (default: 1). */
  lineWidth?: number;
}

const DEFAULT_STUB_LENGTH = 18;
const DEFAULT_LINE_WIDTH = 1;

/**
 * Compute the endpoint of a stub given a start point, direction, and length.
 * All stubs are axis-aligned — EasyEDA rejects diagonal wire segments.
 */
function stubEndpoint(
  x: number,
  y: number,
  direction: StubDirection,
  length: number,
): { x: number; y: number } {
  switch (direction) {
    case 'left':
      return { x: x - length, y };
    case 'right':
      return { x: x + length, y };
    case 'up':
      return { x, y: y + length };
    case 'down':
      return { x, y: y - length };
  }
}

/**
 * Generate wire stubs from a set of pin descriptors.
 *
 * Each descriptor produces exactly one `WorkflowWireInput` — a two-point
 * axis-aligned wire segment that starts at the pin coordinate and extends
 * in the specified direction.
 *
 * @param pins  Array of pin stub descriptors (position, direction, net).
 * @param options  Optional configuration overrides.
 * @returns  An array of workflow wire inputs ready for the planner.
 */
export function generateWireStubs(
  pins: readonly PinStubDescriptor[],
  options?: WireStubGeneratorOptions,
): WorkflowWireInput[] {
  const defaultLength = options?.defaultLength ?? DEFAULT_STUB_LENGTH;
  const lineWidth = options?.lineWidth ?? DEFAULT_LINE_WIDTH;

  return pins.map((pin) => {
    const direction = pin.direction ?? 'right';
    const length = pin.length ?? defaultLength;
    const end = stubEndpoint(pin.x, pin.y, direction, length);

    return {
      ref: `${pin.ref}-pin${pin.pin}-stub`,
      role: `${pin.ref}-pin${pin.pin}-${pin.netName}-stub`,
      netName: pin.netName,
      points: [{ x: pin.x, y: pin.y }, end],
      lineWidth,
    };
  });
}

/** Pin descriptor relative to a component's placement offset from anchor. */
export interface RelativePinStub {
  /** Pin number / identifier. */
  pin: string;
  /** Net name the stub belongs to. */
  netName: string;
  /** Pin X relative to the component's placement position. */
  dx: number;
  /** Pin Y relative to the component's placement position. */
  dy: number;
  /** Stub direction (default: 'right'). */
  direction?: StubDirection;
  /** Stub length override. */
  length?: number;
}

/** A component with its placement offset and relative pin stubs. */
export interface ComponentStubSpec {
  /** Reference designator. */
  ref: string;
  /** Component placement offset from anchor. */
  placementOffset: { dx: number; dy: number };
  /** Pins that need wire stubs, relative to the component's position. */
  pins: readonly RelativePinStub[];
}

/**
 * Generate wire stubs for multiple components, given an anchor point.
 *
 * Each component's pin positions are computed as:
 *   pin.x = anchor.x + component.placementOffset.dx + pin.dx
 *   pin.y = anchor.y + component.placementOffset.dy + pin.dy
 *
 * This is the primary entry point for template authors — it takes the same
 * anchor and placement offsets used for component placement, so stub
 * positions are automatically consistent with component positions.
 */
export function generateStubsForComponents(
  anchor: { x: number; y: number },
  components: readonly ComponentStubSpec[],
  options?: WireStubGeneratorOptions,
): WorkflowWireInput[] {
  const pins: PinStubDescriptor[] = [];

  for (const component of components) {
    const compX = anchor.x + component.placementOffset.dx;
    const compY = anchor.y + component.placementOffset.dy;

    for (const pin of component.pins) {
      pins.push({
        ref: component.ref,
        pin: pin.pin,
        netName: pin.netName,
        x: compX + pin.dx,
        y: compY + pin.dy,
        direction: pin.direction,
        length: pin.length,
      });
    }
  }

  return generateWireStubs(pins, options);
}

/**
 * Helper for the common two-pin passive component pattern (resistor, capacitor, LED).
 * Produces two stubs: pin 1 to the left, pin 2 to the right.
 */
export function twoPinPassiveStubs(
  ref: string,
  offset: { dx: number; dy: number },
  pin1Net: string,
  pin2Net: string,
  pinSpacing = 20,
): ComponentStubSpec {
  return {
    ref,
    placementOffset: offset,
    pins: [
      { pin: '1', netName: pin1Net, dx: -pinSpacing, dy: 0, direction: 'left' },
      { pin: '2', netName: pin2Net, dx: pinSpacing, dy: 0, direction: 'right' },
    ],
  };
}
