import { describe, it, expect } from 'vitest';
import { validateExportManifest } from '../../../src/export-manifest/validation.js';
import { ExportManifestCode } from '../../../src/export-manifest/errors.js';
import { ArtifactType, ExportArtifactRole } from '../../../src/export-manifest/types.js';
import type { ExportManifestInput } from '../../../src/export-manifest/types.js';

function manifest(roles: ExportArtifactRole[]): ExportManifestInput {
  return {
    version: '1.0.0',
    sourceProjectId: 'proj-qa',
    generatedAt: '2026-07-01T00:00:00.000Z',
    artifacts: roles.map((role) => ({
      filename: `${role}.md`,
      fileType: ArtifactType.Documentation,
      role,
      purpose: role,
      sourceProject: 'proj-qa',
      generatedByTool: 'easyeda_production_qa_artifacts',
      timestamp: '2026-07-01T00:00:00.000Z',
      checksum: 'a'.repeat(64),
      checksumAlgorithm: 'sha256',
      fileSize: 100,
      required: true,
      stale: false,
    })),
    manufacturingPolicy: { requiredRoles: roles },
  };
}

describe('production QA manifest roles', () => {
  it('accepts all production QA artifact roles', () => {
    const roles = [
      ExportArtifactRole.TestpointChecklist,
      ExportArtifactRole.AssemblyNotes,
      ExportArtifactRole.BringupPlan,
      ExportArtifactRole.ProductionQaChecklist,
      ExportArtifactRole.QaManifest,
    ];
    const result = validateExportManifest(manifest(roles));

    expect(result.valid).toBe(true);
    expect(result.summary.missingRequiredRoles).toBe(0);
  });

  it('fails when a required QA role is absent', () => {
    const input = manifest([]);
    input.manufacturingPolicy = { requiredRoles: [ExportArtifactRole.TestpointChecklist] };
    const result = validateExportManifest(input);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.code === ExportManifestCode.MISSING_REQUIRED_ROLE),
    ).toBe(true);
  });
});
