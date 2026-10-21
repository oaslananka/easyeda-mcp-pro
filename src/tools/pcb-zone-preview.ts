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

// The native 3.2.206 signature has nine positional arguments. Never infer
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
    planHash,
    requiredApplyChecks: [
      'Exact EasyEDA Pro runtime and native capabilities must be verified.',
      'An active PCB document must be confirmed before mutation.',
      'The netName must exist in the current PCB net inventory; native create does not enforce this.',
      'Polygon must have a verified intersection with the actual board outline; overhang may be clipped. Bounding-box overlap is not topology proof.',
      'An explicit confirmWrite=true and applicable remote approval are mandatory.',
      'Fresh Pour and target-associated Poured read-back must match the created id.',
      'Write timeouts require inventory reconciliation, never blind retry.',
      'Any failed or partial write requires exact-id deletion and verified rollback.',
    ],
  };
}
