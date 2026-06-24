import { createHash } from 'node:crypto';
import { ZodError, z } from 'zod';
import { type ToolDefinition } from './types.js';

export const writeModeSchema = z.enum(['plan', 'preview', 'apply', 'verify']);
export type WriteMode = z.infer<typeof writeModeSchema>;

export const writePlanOutputSchema = z.object({
  success: z.literal(true),
  transaction: z.object({
    id: z.string(),
    toolName: z.string(),
    phase: writeModeSchema,
    willApply: z.boolean(),
    bridgeCallRequired: z.boolean(),
    confirmWriteRequired: z.boolean(),
    confirmWriteSatisfied: z.boolean(),
    risk: z.enum(['low', 'medium', 'high']),
    requiredScopes: z.array(z.string()),
    summary: z.string(),
    inputPreview: z.record(z.string(), z.unknown()),
    nextStep: z
      .object({
        writeMode: z.literal('apply'),
        confirmWrite: z.literal(true),
      })
      .optional(),
  }),
});

export function getRawInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

export function parseWriteMode(raw: Record<string, unknown>): WriteMode | ZodError {
  if (raw.writeMode === undefined) return 'apply';
  const parsed = writeModeSchema.safeParse(raw.writeMode);
  return parsed.success ? parsed.data : parsed.error;
}

export function omitWriteControls(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const {
    confirmWrite: _confirmWrite,
    writeMode: _writeMode,
    ...rest
  } = input as Record<string, unknown>;
  return rest;
}

function transactionId(
  toolName: string,
  phase: WriteMode,
  inputPreview: Record<string, unknown>,
): string {
  const payload = JSON.stringify({ toolName, phase, inputPreview });
  return `wtx_${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
}

export function writePlanResponse(
  tool: ToolDefinition,
  phase: Exclude<WriteMode, 'apply'>,
  inputPreview: Record<string, unknown>,
  requiredScopes: string[],
) {
  const transaction = {
    id: transactionId(tool.name, phase, inputPreview),
    toolName: tool.name,
    phase,
    willApply: false,
    bridgeCallRequired: false,
    confirmWriteRequired: true,
    confirmWriteSatisfied: false,
    risk: tool.risk,
    requiredScopes,
    summary:
      phase === 'verify'
        ? `Verification checkpoint prepared for "${tool.name}". No bridge call was executed; run read-only diagnostics after apply to verify project state.`
        : `${phase === 'plan' ? 'Plan' : 'Preview'} prepared for "${tool.name}". No bridge call was executed.`,
    inputPreview,
    nextStep:
      phase === 'verify'
        ? undefined
        : {
            writeMode: 'apply' as const,
            confirmWrite: true as const,
          },
  };

  const structuredContent = writePlanOutputSchema.parse({ success: true, transaction });
  return {
    structuredContent,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
  };
}

export function registeredOutputSchema(tool: ToolDefinition): z.ZodType {
  if (!tool.confirmWrite) return tool.outputSchema;
  return z.union([tool.outputSchema, writePlanOutputSchema]);
}
