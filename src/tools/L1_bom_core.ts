import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

function registerBomCoreTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_bom_generate',
    title: 'Generate BOM',
    description:
      'Generate a bill of materials for the project with grouping and formatting options.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'bom',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      format: z.enum(['csv', 'json', 'xlsx']).default('json'),
      groupBy: z.enum(['value', 'lcsc', 'footprint']).default('value'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      format: z.string(),
      group_by: z.string(),
      entries: z.array(
        z.object({
          reference: z.string(),
          value: z.string(),
          footprint: z.string(),
          lcsc: z.string().optional(),
          quantity: z.number().int().nonnegative(),
          manufacturer: z.string().optional(),
        }),
      ),
      total_entries: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, format, groupBy } = params as {
        projectId: string;
        format: string;
        groupBy: string;
      };
      try {
        const result = await ctx.bridge.call('bom.generate', { projectId, format, groupBy });
        const entries = result as Array<{
          reference?: string;
          value?: string;
          footprint?: string;
          lcsc?: string;
          quantity?: number;
          manufacturer?: string;
        }>;
        const validEntries = (entries ?? []).filter((entry) => entry.reference?.trim());
        return {
          project_id: projectId,
          format,
          group_by: groupBy,
          entries: validEntries.map((e) => ({
            reference: e.reference ?? '',
            value: e.value ?? '',
            footprint: e.footprint ?? '',
            lcsc: e.lcsc,
            quantity: e.quantity ?? 0,
            manufacturer: e.manufacturer,
          })),
          total_entries: validEntries.length,
        };
      } catch (err) {
        return {
          project_id: projectId,
          format,
          group_by: groupBy,
          entries: [],
          total_entries: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_bom_validate',
    title: 'Validate BOM',
    description:
      'Validate the project BOM against LCSC inventory to identify missing, obsolete, or alternate parts.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: false,
    group: 'bom',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      total_parts: z.number().int().nonnegative(),
      missing_lcsc: z.array(z.string()),
      invalid_lcsc: z.array(z.string()),
      obsolete: z.array(z.string()),
      valid_count: z.number().int().nonnegative(),
      validated: z.boolean(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const bomResult = await ctx.bridge.call('bom.generate', {
          projectId,
          format: 'json',
          groupBy: 'lcsc',
        });
        const entries = bomResult as Array<{ lcsc?: string; reference: string; value: string }>;

        const missing: string[] = [];
        const invalid: string[] = [];
        const obsolete: string[] = [];

        for (const entry of entries ?? []) {
          if (!entry.lcsc) {
            missing.push(entry.reference);
            continue;
          }

          if (ctx.vendors.lcsc) {
            try {
              const detail = await ctx.vendors.lcsc.getPartDetail(entry.lcsc);
              if (!detail) {
                invalid.push(entry.reference);
              } else if (detail.discontinued) {
                obsolete.push(entry.reference);
              }
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (_err) {
              // LCSC lookup failed for this part
              invalid.push(entry.reference);
            }
          }
        }

        return {
          project_id: projectId,
          total_parts: entries?.length ?? 0,
          missing_lcsc: missing,
          invalid_lcsc: invalid,
          obsolete: obsolete,
          valid_count: (entries?.length ?? 0) - missing.length - invalid.length - obsolete.length,
          validated: true,
        };
      } catch (err) {
        return {
          project_id: projectId,
          total_parts: 0,
          missing_lcsc: [],
          invalid_lcsc: [],
          obsolete: [],
          valid_count: 0,
          validated: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_bom_export',
    title: 'Export BOM',
    description: 'Export the bill of materials to a file on disk in the specified format.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'bom',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: z.object({
      projectId: z.string(),
      format: z.enum(['csv', 'json', 'xlsx']).default('csv'),
      filePath: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      format: z.string(),
      file_path: z.string(),
      exported: z.boolean(),
      entry_count: z.number().int().nonnegative().optional(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, format, filePath } = params as {
        projectId: string;
        format: string;
        filePath: string;
      };
      const resolved = path.resolve(filePath);
      const artifactDir = path.resolve(ctx.config.artifactDir as string);
      const relative = path.relative(artifactDir, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return {
          project_id: projectId,
          format,
          file_path: filePath,
          exported: false,
          not_available: true,
        };
      }
      const parentDir = path.dirname(resolved);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      try {
        const result = await ctx.bridge.call('bom.generate', {
          projectId,
          format,
          exportPath: filePath,
        });
        const data = result as { entryCount?: number };
        return {
          project_id: projectId,
          format,
          file_path: filePath,
          exported: true,
          entry_count: data.entryCount ?? 0,
        };
      } catch (err) {
        return {
          project_id: projectId,
          format,
          file_path: filePath,
          exported: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerBomCoreTools };
