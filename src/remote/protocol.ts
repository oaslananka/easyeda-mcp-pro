import { z } from 'zod';

export const REMOTE_RELAY_PROTOCOL_VERSION = '2026-07-remote-relay-v1' as const;
export const RemoteDeploymentModeSchema = z.enum(['local', 'hosted', 'self_hosted']);
export const RemoteRiskLevelSchema = z.enum(['read', 'write', 'export', 'destructive']);
export const RemoteScopeSchema = z.enum([
  'easyeda.read',
  'easyeda.write',
  'easyeda.export',
  'easyeda.project_admin',
]);

export type RemoteDeploymentMode = z.infer<typeof RemoteDeploymentModeSchema>;
export type RemoteRiskLevel = z.infer<typeof RemoteRiskLevelSchema>;
export type RemoteScope = z.infer<typeof RemoteScopeSchema>;

export const ActiveProjectSchema = z.object({
  projectId: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  documentType: z.enum(['schematic', 'pcb', 'unknown']).default('unknown'),
  url: z.string().url().optional(),
});

export type ActiveProject = z.infer<typeof ActiveProjectSchema>;

const BaseRelayMessageSchema = z.object({
  protocolVersion: z.literal(REMOTE_RELAY_PROTOCOL_VERSION),
  messageId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  timestamp: z.string().datetime(),
});

export const RegisterSessionMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('register_session'),
  extensionVersion: z.string().min(1),
  mode: RemoteDeploymentModeSchema.exclude(['local']),
  activeProject: ActiveProjectSchema.optional(),
  capabilities: z.array(z.string().min(1)).default([]),
});

export const SessionRegisteredMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('session_registered'),
  sessionId: z.string().min(1),
  paired: z.boolean(),
  expiresAt: z.string().datetime(),
});

export const HeartbeatMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('heartbeat'),
});

export const ToolRequestMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('tool_request'),
  sessionId: z.string().min(1),
  toolName: z.string().min(1),
  riskLevel: RemoteRiskLevelSchema,
  requiresApproval: z.boolean(),
  input: z.unknown().optional(),
  inputHash: z.string().min(1),
  activeProjectHint: ActiveProjectSchema.optional(),
  deadlineMs: z.number().int().positive().optional(),
});

export const ToolResponseMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('tool_response'),
  sessionId: z.string().min(1),
  requestMessageId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      suggestion: z.string().min(1).optional(),
    })
    .optional(),
  durationMs: z.number().nonnegative(),
});

export const ApprovalRequestMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('approval_request'),
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  toolName: z.string().min(1),
  riskLevel: RemoteRiskLevelSchema,
  actionSummary: z.string().min(1),
  inputHash: z.string().min(1),
  activeProject: ActiveProjectSchema.optional(),
  expiresAt: z.string().datetime(),
});

export const ApprovalResultMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('approval_result'),
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  result: z.enum(['approved', 'rejected', 'timeout']),
});

export const SessionClosedMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('session_closed'),
  sessionId: z.string().min(1),
  reason: z.enum(['user_disabled', 'expired', 'disconnected', 'replaced']),
});

export const RelayErrorMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('error'),
  sessionId: z.string().min(1).optional(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const RelayMessageSchema = z.discriminatedUnion('type', [
  RegisterSessionMessageSchema,
  SessionRegisteredMessageSchema,
  HeartbeatMessageSchema,
  ToolRequestMessageSchema,
  ToolResponseMessageSchema,
  ApprovalRequestMessageSchema,
  ApprovalResultMessageSchema,
  SessionClosedMessageSchema,
  RelayErrorMessageSchema,
]);

export type RelayMessage = z.infer<typeof RelayMessageSchema>;
export type RegisterSessionMessage = z.infer<typeof RegisterSessionMessageSchema>;
export type ToolRequestMessage = z.infer<typeof ToolRequestMessageSchema>;
export type ApprovalRequestMessage = z.infer<typeof ApprovalRequestMessageSchema>;
