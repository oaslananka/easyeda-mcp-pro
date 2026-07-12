import { z } from 'zod';

/** Shared, datasheet-driven intent for the USB 2.0 / isolated RS-485 fixture. */
export const UsbIsolatedRs485ReferenceSchema = z.object({
  kind: z.literal('usb-isolated-rs485'),
  usbRole: z.literal('data-power').default('data-power'),
  isolation: z.literal('galvanic').default('galvanic'),
  inputVoltage: z.number().positive().default(5),
  inputCurrentAmps: z.number().positive().default(0.5),
  rs485BusVoltage: z.number().positive().default(5),
  terminationOhms: z.number().positive().default(120),
  biasResistorOhms: z.number().positive().default(680),
  usbDataRateMbps: z.number().positive().default(12),
  isolationClearanceMm: z.number().positive().default(8),
  notes: z.array(z.string().max(512)).default([]),
});

export type UsbIsolatedRs485Reference = z.infer<typeof UsbIsolatedRs485ReferenceSchema>;

