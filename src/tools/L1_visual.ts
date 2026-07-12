import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { inferSchematicSheetGeometry } from '../workflows/schematic-safe-region.js';

interface CanvasBinaryResult {
  base64?: string;
  mimeType?: string;
  fileName?: string;
  byteLength?: number;
  selectionCleared?: boolean;
}

const captureOutputSchema = z.object({
  captured: z.boolean(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
  byte_length: z.number().int().nonnegative().optional(),
  /** Present in the raw handler result so `imageContentFromCapture` can build the
   *  response's dedicated `image` content block — but omitted from
   *  structuredContent/the JSON text block by `imageContentOmitFields` below, so
   *  a successful capture doesn't send the same base64 payload three times. */
  image_base64: z.string().optional(),
  not_available: z.boolean().optional(),
  error: z.string().optional(),
});

type CaptureOutput = z.infer<typeof captureOutputSchema>;

const fullPageCaptureOutputSchema = captureOutputSchema.extend({
  project_id: z.string(),
  sheet: z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
      unit: z.string(),
      source: z.enum(['sheet-info', 'default-a4-landscape']),
    })
    .optional(),
  viewport: z
    .object({
      left: z.number(),
      right: z.number(),
      top: z.number(),
      bottom: z.number(),
    })
    .optional(),
  image_dimensions: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
  sheet_to_image_transform: z
    .object({
      scale_x: z.number(),
      scale_y: z.number(),
      offset_x: z.number(),
      offset_y: z.number(),
    })
    .optional(),
  selection_overlays_removed: z.boolean().optional(),
  deterministic_viewport: z.boolean(),
  warnings: z.array(z.string()),
});

type FullPageCaptureOutput = z.infer<typeof fullPageCaptureOutputSchema>;

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

function readPngDimensions(base64: string): { width: number; height: number } | undefined {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
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
      'given tab (or last-focused); use easyeda_canvas_capture_region first to frame a ' +
      'specific area. Image is delivered once, as its own content block.',
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
    imageContentOmitFields: ['image_base64'],
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
      "the user's visible viewport — EasyEDA Pro has no offscreen rendering API. The image " +
      'is delivered once, as its own content block.',
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
    imageContentOmitFields: ['image_base64'],
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
    name: 'easyeda_schematic_capture_full_page',
    title: 'Capture a complete schematic page',
    description:
      'Read the active schematic sheet geometry, clear selection overlays, frame the complete ' +
      'sheet including its border and title block, and return a deterministic PNG plus the ' +
      'sheet-to-image coordinate transform. Refuses guessed geometry unless explicitly allowed.',
    profile: 'pro',
    evidence: ['pro-api-types', 'runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'visual',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().min(1),
      tabId: z.string().optional(),
      padding: z.number().nonnegative().default(0),
      allowInferredA4: z.boolean().default(false),
    }),
    outputSchema: fullPageCaptureOutputSchema,
    imageContent: imageContentFromCapture,
    imageContentOmitFields: ['image_base64'],
    handler: async (ctx: ToolContext, params: unknown): Promise<FullPageCaptureOutput> => {
      const values = params as {
        projectId: string;
        tabId?: string;
        padding?: number;
        allowInferredA4?: boolean;
      };
      const { projectId, tabId } = values;
      const padding = values.padding ?? 0;
      const allowInferredA4 = values.allowInferredA4 ?? false;
      const warnings: string[] = [];
      try {
        const sheetInfo = await ctx.bridge.call('schematic.getSheetInfo', { projectId });
        const sheet = inferSchematicSheetGeometry(sheetInfo);
        if (sheet.source !== 'sheet-info' && !allowInferredA4) {
          return {
            project_id: projectId,
            captured: false,
            not_available: true,
            deterministic_viewport: false,
            warnings: ['Runtime sheet geometry is unavailable; capture was not attempted.'],
            error:
              'Full-page capture requires runtime sheet geometry. Set allowInferredA4 only for diagnostic fixtures.',
          };
        }
        if (sheet.source !== 'sheet-info') {
          warnings.push('Using inferred A4 landscape geometry; the viewport is not runtime-proven.');
        }

        const viewport = {
          left: -padding,
          right: sheet.width + padding,
          top: sheet.height + padding,
          bottom: -padding,
        };
        const raw = (await ctx.bridge.call('canvas.captureRegion', {
          ...viewport,
          tabId,
          clearSelection: true,
        })) as CanvasBinaryResult;
        const capture = buildCaptureOutput(raw);
        const imageDimensions = raw.base64 ? readPngDimensions(raw.base64) : undefined;
        if (!imageDimensions) warnings.push('PNG image dimensions could not be decoded.');
        if (raw.selectionCleared !== true) {
          warnings.push('The bridge could not prove that selection overlays were cleared.');
        }

        const regionWidth = viewport.right - viewport.left;
        const regionHeight = viewport.top - viewport.bottom;
        const transform = imageDimensions
          ? {
              scale_x: imageDimensions.width / regionWidth,
              scale_y: -imageDimensions.height / regionHeight,
              offset_x: -viewport.left * (imageDimensions.width / regionWidth),
              offset_y: viewport.top * (imageDimensions.height / regionHeight),
            }
          : undefined;

        return {
          project_id: projectId,
          ...capture,
          sheet: {
            width: sheet.width,
            height: sheet.height,
            unit: sheet.unit,
            source: sheet.source,
          },
          viewport,
          image_dimensions: imageDimensions,
          sheet_to_image_transform: transform,
          selection_overlays_removed: raw.selectionCleared,
          deterministic_viewport: sheet.source === 'sheet-info',
          warnings,
        };
      } catch (err) {
        return {
          project_id: projectId,
          captured: false,
          not_available: true,
          deterministic_viewport: false,
          warnings,
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
