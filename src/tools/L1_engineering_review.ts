import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import { buildEngineeringReview, engineeringReviewSchema } from '../engineering-review/report.js';
import { fetchBoardEvidenceFromBridge } from './L1_pcb_constraints.js';
import { type ToolContext, type ToolDefinition } from './types.js';

/** This operation only reads board inspection data; it never runs native ERC/DRC. */
export function registerEngineeringReviewTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
): void {
  registry.register({
    name: 'easyeda_engineering_review',
    title: 'Review observed engineering evidence',
    description:
      'Read PCB inspection evidence and summarize existing constraint rules with stable findings, source provenance and explicit unknowns. Does not execute ERC, DRC, design writes or exports, and cannot approve fabrication.',
    profile: 'core',
    evidence: ['inferred', 'runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    sideEffect: 'read-only',
    group: 'pcb-constraints',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({ projectId: z.string().trim().min(1) }),
    outputSchema: engineeringReviewSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      const easyedaVersionBefore = ctx.bridge.easyedaVersion;
      const extensionVersionBefore = ctx.bridge.extensionVersion;
      const evidence = await fetchBoardEvidenceFromBridge(ctx, projectId);
      const sourceChangedDuringRead =
        easyedaVersionBefore !== ctx.bridge.easyedaVersion ||
        extensionVersionBefore !== ctx.bridge.extensionVersion;
      return buildEngineeringReview({
        projectId,
        boardData: evidence.data,
        observations: evidence.observations,
        bridgeConnected: ctx.bridge.connected,
        registryMismatch: ctx.bridge.registryMismatch,
        extensionVersionMismatch: ctx.bridge.extensionVersionMismatch,
        sourceChangedDuringRead,
        easyedaVersion: ctx.bridge.easyedaVersion,
        extensionVersion: ctx.bridge.extensionVersion,
        evidenceMode: 'native',
      });
    },
  });
}
