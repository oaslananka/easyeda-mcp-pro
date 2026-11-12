import { createHash } from 'node:crypto';
import { z } from 'zod';

const finiteCoordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const positiveDimension = z.number().finite().positive().max(1_000_000);

export const pcbZoneRectangleSchema = z
  .object({
    x: finiteCoordinate,
    y: finiteCoordinate,
    width: positiveDimension,
    height: positiveDimension,
  })
  .strict()
  .refine((rect) => rect.x + rect.width <= 1_000_000, {
    message: 'Rectangle must not exceed the native PCB X-coordinate limit.',
    path: ['width'],
  })
  // EasyEDA native rectangle height extends downward from y (toward negative Y).
  .refine((rect) => rect.y - rect.height >= -1_000_000, {
    message: 'Rectangle must not exceed the negative native PCB Y-coordinate limit.',
    path: ['height'],
  });

// The nine positional arguments were verified in one disposable 3.2.209 runtime. Never infer
// priorities, dimensions, net identities or fill settings on the user's behalf.
export const pcbZonePreviewSchema = z
  .object({
    rectangle: pcbZoneRectangleSchema,
    layer: z.union([z.literal(1), z.literal(2)]),
    netName: z.string().trim().min(1).max(128),
    fillMethod: z.literal('solid'),
    preserveSilos: z.boolean(),
    pourName: z.string().trim().min(1).max(128),
    pourPriority: z.number().int().min(0).max(100),
    lineWidth: positiveDimension,
    locked: z.boolean(),
  })
  .strict();

export type PcbZonePreviewInput = z.infer<typeof pcbZonePreviewSchema>;

/** This is evidence for one disposable native runtime, NOT generic API support. */
export function observedZoneNativeProfile(input: PcbZonePreviewInput) {
  const blockers = [
    ...(input.netName !== 'GND' ? ['native-net-unsupported'] : []),
    ...(input.layer !== 2 ? ['native-layer-unsupported'] : []),
    ...(!input.preserveSilos ? ['native-islands-mode-unsupported'] : []),
    ...(input.pourPriority !== 1 ? ['native-priority-unsupported'] : []),
    ...(input.lineWidth !== 0.2 ? ['native-line-width-unsupported'] : []),
    ...(input.locked ? ['native-lock-mode-unsupported'] : []),
  ];
  return {
    observedInDisposableRuntime: blockers.length === 0,
    evidenceRuntime: '3.2.209' as const,
    blockers,
  };
}

const nativeZonePreflightShape = z.object({
  runtimeVersion: z.string().nullable(),
  runtimeVerified: z.boolean(),
  activePcb: z.boolean(),
  nativeCapabilities: z.boolean(),
  netVerified: z.boolean(),
  layerVerified: z.boolean(),
  boardGeometry: z
    .object({
      containmentVerified: z.boolean(),
    })
    .nullable()
    .optional(),
  readyToApply: z.literal(false),
  blockers: z.array(z.string()),
});

export type ZoneLiveReadiness = {
  checked: boolean;
  runtimeVersion: string | null;
  focusedPcbVerified: boolean;
  netVerified: boolean;
  layerVerified: boolean;
  boardContainmentVerified: boolean;
  readyToApply: false;
  blockers: string[];
};

export function unavailableZoneLiveReadiness(): ZoneLiveReadiness {
  return {
    checked: false,
    runtimeVersion: null,
    focusedPcbVerified: false,
    netVerified: false,
    layerVerified: false,
    boardContainmentVerified: false,
    readyToApply: false,
    blockers: ['live-zone-preflight-unavailable'],
  };
}

/** Parse untrusted bridge probe evidence without treating success-like values as write consent. */
export function summarizeZoneLiveReadiness(raw: unknown): ZoneLiveReadiness {
  const parsed = nativeZonePreflightShape.safeParse(raw);
  if (!parsed.success) return unavailableZoneLiveReadiness();
  const value = parsed.data;
  const boardContainmentVerified =
    value.runtimeVerified && value.activePcb && value.boardGeometry?.containmentVerified === true;
  const additional = [
    ...(!value.runtimeVerified ? ['runtime-version-unverified'] : []),
    ...(!value.activePcb ? ['active-pcb-unverified'] : []),
    ...(!value.nativeCapabilities ? ['native-zone-capabilities-unavailable'] : []),
    ...(!value.netVerified ? ['net-not-in-active-pcb'] : []),
    ...(!value.layerVerified ? ['copper-layer-unverified'] : []),
    ...(!boardContainmentVerified ? ['candidate-board-containment-unverified'] : []),
  ];
  return {
    checked: true,
    runtimeVersion: value.runtimeVersion,
    focusedPcbVerified: value.activePcb,
    netVerified: value.netVerified,
    layerVerified: value.layerVerified,
    boardContainmentVerified,
    readyToApply: false,
    blockers: [...new Set([...value.blockers, ...additional])],
  };
}

export function previewPcbZone(input: PcbZonePreviewInput) {
  const {
    rectangle,
    layer,
    netName,
    fillMethod,
    preserveSilos,
    pourName,
    pourPriority,
    lineWidth,
    locked,
  } = pcbZonePreviewSchema.parse(input);
  const polygonSource: [string, number, number, number, number, number, number] = [
    'R',
    rectangle.x,
    rectangle.y,
    rectangle.width,
    rectangle.height,
    0,
    0,
  ];
  const nativeArguments = {
    net: netName,
    layer,
    polygonSource,
    fillMethod,
    preserveSilos,
    pourName,
    pourPriority,
    lineWidth,
    locked,
  };
  const planHash = createHash('sha256').update(JSON.stringify(nativeArguments)).digest('hex');
  return {
    target: 'PCB_PrimitivePour.create' as const,
    nativeArguments,
    nativeProfile: observedZoneNativeProfile(input),
    planHash,
    requiredApplyChecks: [
      'Exact EasyEDA Pro runtime and native capabilities must be verified.',
      'An active PCB document must be confirmed before mutation.',
      'The netName must exist in the current PCB net inventory; native create does not enforce this.',
      'The candidate must be strictly contained by the verified actual board outline; overlap, boundary contact and unsupported contours do not prove safety.',
      'An explicit confirmWrite=true and applicable remote approval are mandatory.',
      'Actual native source properties and its target-associated true-filled Poured must match the preview; native may silently normalize parameters.',
      'Write timeouts require inventory reconciliation, never blind retry.',
      'Any failed or partial write requires exact-id recovery, independently verified durable rollback and a no-blind-retry fence.',
    ],
  };
}
