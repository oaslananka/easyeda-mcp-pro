import { z } from 'zod';
import { renderNativeObjPreview } from '../pcb-3d-preview/index.js';
import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  pcbId: z.string().trim().min(1).max(256),
  view: z.enum(['isometric', 'underside']).default('isometric'),
});

const outputSchema = z.object({
  project_id: z.string(),
  pcb_id: z.string(),
  view: z.enum(['isometric', 'underside']),
  preview_generated: z.boolean(),
  source: z.literal('exported-obj-geometry'),
  native_capture: z.literal(false),
  model_coverage: z.literal('unverified'),
  warnings: z.array(z.string()),
  source_sha256: z.string().optional(),
  vertex_count: z.number().int().positive().optional(),
  triangle_count: z.number().int().positive().optional(),
  image_dimensions: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
  image_base64: z.string().optional(),
  mime_type: z.literal('image/png').optional(),
  not_available: z.boolean().optional(),
  error: z.string().optional(),
});

export const pcb3dPreviewTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'easyeda_pcb_3d_preview',
  title: 'Render a PCB 3D geometry preview',
  description:
    'Render the focused PCB native OBJ export as a CPU-rendered PNG without design edits. Beta export API; tested native format on EasyEDA Pro 4.1.105. Not a native screenshot. Models may be missing or placeholders; not clearance, dimension or manufacturing evidence. Requires export permission.',
  profile: 'pro',
  evidence: ['official-docs', 'runtime-probe'],
  risk: 'low',
  confirmWrite: false,
  sideEffect: 'artifact-write',
  group: 'export',
  version: '1.0.0',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema,
  outputSchema,
  imageContentOmitFields: ['image_base64'],
  imageContent: (output) =>
    output.preview_generated && output.image_base64
      ? [{ data: output.image_base64, mimeType: 'image/png' }]
      : [],
  handler: async (context, { projectId, pcbId, view }) => {
    const base = {
      project_id: projectId,
      pcb_id: pcbId,
      view,
      source: 'exported-obj-geometry' as const,
      native_capture: false as const,
      model_coverage: 'unverified' as const,
      warnings: [
        'Exported geometry may omit real models or include placeholders even with automatic model generation disabled.',
        'Image is a visual aid, not verified component dimensions, mechanical clearance, or manufacturing approval.',
        'Camera orientation is relative to the exported mesh, not the EasyEDA editor view state.',
      ],
    };
    try {
      const response = await context.bridge.call(
        'board.preview3d',
        { projectId, pcbId },
        { timeoutMs: 60_000 },
      );
      const proof = response as
        { projectId?: unknown; pcbId?: unknown; autoGenerateModels?: unknown } | undefined;
      if (
        proof?.projectId !== projectId ||
        proof.pcbId !== pcbId ||
        proof.autoGenerateModels !== false
      ) {
        throw new Error(
          'Native export does not prove the requested PCB identity and export settings.',
        );
      }
      const result = renderNativeObjPreview(response, view);
      return {
        ...base,
        preview_generated: true,
        source_sha256: result.sourceSha256,
        vertex_count: result.vertexCount,
        triangle_count: result.triangleCount,
        image_dimensions: { width: result.width, height: result.height },
        image_base64: result.png.toString('base64'),
        mime_type: 'image/png',
      };
    } catch {
      return {
        ...base,
        preview_generated: false,
        not_available: true,
        error:
          'PCB preview unavailable. Focus the requested PCB, use a current bridge and an export-capable EasyEDA version, and check the board outline. Larger or unsupported meshes require regular 3D export.',
      };
    }
  },
};

export function registerPcb3dPreviewTool(registry: ToolRegistry): void {
  registry.register(pcb3dPreviewTool);
}
