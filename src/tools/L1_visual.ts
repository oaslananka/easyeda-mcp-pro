import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

interface CanvasBinaryResult {
  base64?: string;
  mimeType?: string;
  fileName?: string;
  byteLength?: number;
}

const captureOutputSchema = z.object({
  captured: z.boolean(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
  byte_length: z.number().int().nonnegative().optional(),
  image_base64: z.string().optional(),
  not_available: z.boolean().optional(),
  error: z.string().optional(),
});

type CaptureOutput = z.infer<typeof captureOutputSchema>;

function imageContentFromCapture(output: unknown): Array<{ data: string; mimeType: string }> {
  const data = output as CaptureOutput;
  if (!data.captured || !data.image_base64) return [];
  return [{ data: data.image_base64, mimeType: data.mime_type ?? 'image/png' }];
}

/**
 * Build the tool's output from a raw `canvas.capture`/`canvas.captureRegion`
 * bridge result. A successful bridge call already respects the wire's
 * payload-size limit (the extension self-limits before sending — see
 * `easyeda-bridge-extension/src/binary-result.ts` and
 * `normalizeBinaryResultSafely` in the extension), so no size is re-checked
 * here; a too-large capture surfaces as a bridge error caught by the caller.
 */
function buildCaptureOutput(result: unknown): CaptureOutput {
  const data = result as CanvasBinaryResult | undefined;
  if (!data?.base64) {
    return { captured: false, not_available: true, error: 'Bridge did not return image data.' };
  }
  return {
    captured: true,
    mime_type: data.mimeType ?? 'image/png',
    file_name: data.fileName,
    byte_length: data.byteLength,
    image_base64: data.base64,
  };
}

function registerVisualTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_canvas_capture',
    title: 'Capture canvas image',
    description:
      'Capture the currently visible EasyEDA schematic/PCB canvas as a PNG image, so the ' +
      'caller can visually verify the result of a draw/place/route action. Captures the ' +
      'given tab (or the last-focused one) as-is; use easyeda_canvas_capture_region first ' +
      'to frame a specific area.',
    profile: 'core',
    evidence: ['pro-api-types'],
    risk: 'low',
    confirmWrite: false,
    group: 'visual',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
    },
    inputSchema: z.object({
      tabId: z.string().optional(),
    }),
    outputSchema: captureOutputSchema,
    imageContent: imageContentFromCapture,
    handler: async (ctx: ToolContext, params: unknown) => {
      const { tabId } = params as { tabId?: string };
      try {
        const result = await ctx.bridge.call('canvas.capture', { tabId });
        return buildCaptureOutput(result);
      } catch (err) {
        return {
          captured: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_canvas_capture_region',
    title: 'Capture canvas region image',
    description:
      'Zoom the EasyEDA canvas to a rectangular region (document/canvas coordinates) and ' +
      'capture it as a PNG, so the caller can visually verify a specific area. This moves ' +
      "the user's visible viewport — EasyEDA Pro has no offscreen rendering API.",
    profile: 'core',
    evidence: ['pro-api-types'],
    risk: 'low',
    confirmWrite: false,
    group: 'visual',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
    },
    inputSchema: z.object({
      left: z.number(),
      right: z.number(),
      top: z.number(),
      bottom: z.number(),
      tabId: z.string().optional(),
    }),
    outputSchema: captureOutputSchema,
    imageContent: imageContentFromCapture,
    handler: async (ctx: ToolContext, params: unknown) => {
      const { left, right, top, bottom, tabId } = params as {
        left: number;
        right: number;
        top: number;
        bottom: number;
        tabId?: string;
      };
      try {
        const result = await ctx.bridge.call('canvas.captureRegion', {
          left,
          right,
          top,
          bottom,
          tabId,
        });
        return buildCaptureOutput(result);
      } catch (err) {
        return {
          captured: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_canvas_locate',
    title: 'Zoom canvas to coordinate',
    description:
      'Zoom the EasyEDA canvas to a coordinate/scale (document/canvas coordinates), returning ' +
      'the resulting viewport rectangle. Useful to frame a location before calling ' +
      "easyeda_canvas_capture, or standalone to navigate the user's view to a point of interest.",
    profile: 'core',
    evidence: ['pro-api-types'],
    risk: 'low',
    confirmWrite: false,
    group: 'visual',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
    },
    inputSchema: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      scaleRatio: z.number().positive().optional(),
      tabId: z.string().optional(),
    }),
    outputSchema: z.object({
      located: z.boolean(),
      left: z.number().optional(),
      right: z.number().optional(),
      top: z.number().optional(),
      bottom: z.number().optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { x, y, scaleRatio, tabId } = params as {
        x?: number;
        y?: number;
        scaleRatio?: number;
        tabId?: string;
      };
      try {
        const result = await ctx.bridge.call('canvas.locate', { x, y, scaleRatio, tabId });
        const rect = result as
          { left?: number; right?: number; top?: number; bottom?: number } | false;
        if (!rect) {
          return {
            located: false,
            not_available: true,
            error: 'EasyEDA could not zoom to the requested coordinate.',
          };
        }
        return {
          located: true,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      } catch (err) {
        return {
          located: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerVisualTools };
