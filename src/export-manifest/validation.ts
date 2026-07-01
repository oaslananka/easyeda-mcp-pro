/**
 * Export manifest — validation rules and entry point.
 *
 * Implements 10 validation rules that operate on {@link ExportManifestInput}
 * and produce structured {@link ExportManifestIssue}s.
 *
 * Rules:
 *  1. Invalid manifest version  — error if version is not valid semver
 *  2. Missing source project    — error if sourceProjectId is empty
 *  3. Missing generated timestamp — error if generatedAt is empty
 *  4. Missing purpose           — warning for each artifact without purpose
 *  5. Empty file                — error for each artifact with fileSize === 0
 *  6. Stale file                — warning for each artifact flagged stale
 *  7. Checksum mismatch         — error when expected checksum != actual
 *  8. Missing required file     — error when expected artifact not found in output
 *  9. Unexpected file           — warning when output file not in expected set
 * 10. Wrong file type           — error when artifact type doesn't match expected
 * 11. Missing artifact metadata — error/warning for missing checksum, size, or generator data
 * 12. Manufacturing roles       — error when required board outline, drill, or layer roles are missing
 * 13. Project metadata          — error when EasyEDA/project metadata is required but absent
 * 14. BOM/PNP consistency       — error when pick-and-place designators are not represented in BOM
 *
 * @module
 */

import { ExportManifestCode, manifestError, manifestWarning } from './errors.js';
import { ExportArtifactRole } from './types.js';
import type { ExportManifestIssue } from './types.js';
import type { ExportManifestInput, ExportManifestReport, ExportManifestSummary } from './types.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Simple semver regex: major.minor.patch with optional pre-release. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/;

// ── Rule: invalid manifest version ──────────────────────────────────────────

function checkManifestVersion(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  if (!input.version || !SEMVER_RE.test(input.version)) {
    issues.push(
      manifestError(
        ExportManifestCode.INVALID_MANIFEST_VERSION,
        `Manifest version "${input.version ?? ''}" is not a valid semver string (expected e.g. "1.0.0")`,
        {
          path: 'version',
          remediationHint: 'Set the manifest version to a valid semver string like "1.0.0"',
          details: { providedVersion: input.version },
        },
      ),
    );
  }

  return issues;
}

// ── Rule: missing source project ────────────────────────────────────────────

function checkSourceProject(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  if (!input.sourceProjectId || input.sourceProjectId.trim().length === 0) {
    issues.push(
      manifestError(
        ExportManifestCode.MISSING_SOURCE_PROJECT,
        'Manifest is missing a source project identifier',
        {
          path: 'sourceProjectId',
          remediationHint:
            'Set sourceProjectId to the EasyEDA project UUID that produced this export',
        },
      ),
    );
  }

  // Check each artifact for source project
  for (const [i, artifact] of input.artifacts.entries()) {
    if (!artifact.sourceProject || artifact.sourceProject.trim().length === 0) {
      issues.push(
        manifestWarning(
          ExportManifestCode.MISSING_SOURCE_PROJECT,
          `Artifact "${artifact.filename}" is missing a source project reference`,
          {
            path: `artifacts[${i}]`,
            artifactPath: artifact.filename,
            remediationHint:
              'Set sourceProject on each artifact to trace it back to its origin project',
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: missing generated timestamp ────────────────────────────────────────

function checkGeneratedTimestamps(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  // Check manifest-level timestamp
  if (!input.generatedAt || input.generatedAt.trim().length === 0) {
    issues.push(
      manifestError(
        ExportManifestCode.MISSING_GENERATED_TIMESTAMP,
        'Manifest is missing a generation timestamp',
        {
          path: 'generatedAt',
          remediationHint: 'Set generatedAt to the ISO-8601 timestamp of manifest creation',
        },
      ),
    );
  }

  // Check per-artifact timestamps
  for (const [i, artifact] of input.artifacts.entries()) {
    if (!artifact.timestamp || artifact.timestamp.trim().length === 0) {
      issues.push(
        manifestWarning(
          ExportManifestCode.MISSING_GENERATED_TIMESTAMP,
          `Artifact "${artifact.filename}" is missing a generation timestamp`,
          {
            path: `artifacts[${i}]`,
            artifactPath: artifact.filename,
            remediationHint: 'Add an ISO-8601 timestamp to each artifact for staleness tracking',
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: missing purpose ────────────────────────────────────────────────────

function checkMissingPurposes(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  for (const [i, artifact] of input.artifacts.entries()) {
    if (!artifact.purpose || artifact.purpose.trim().length === 0) {
      issues.push(
        manifestWarning(
          ExportManifestCode.MISSING_PURPOSE,
          `Artifact "${artifact.filename}" is missing a purpose description`,
          {
            path: `artifacts[${i}]`,
            artifactPath: artifact.filename,
            remediationHint:
              'Add a brief purpose description (e.g. "Top copper layer", "Schematic PDF")',
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: empty files ────────────────────────────────────────────────────────

function checkEmptyFiles(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  for (const [i, artifact] of input.artifacts.entries()) {
    if (artifact.fileSize !== undefined && artifact.fileSize === 0) {
      issues.push(
        manifestError(
          ExportManifestCode.EMPTY_FILE,
          `Artifact "${artifact.filename}" is empty (0 bytes)`,
          {
            path: `artifacts[${i}]`,
            artifactPath: artifact.filename,
            artifactType: artifact.fileType,
            remediationHint:
              'Re-export the artifact — the file may have been truncated or the export may have failed silently',
            details: { fileSize: artifact.fileSize },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: stale files ────────────────────────────────────────────────────────

function checkStaleFiles(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  for (const [i, artifact] of input.artifacts.entries()) {
    if (artifact.stale) {
      issues.push(
        manifestWarning(
          ExportManifestCode.STALE_FILE,
          `Artifact "${artifact.filename}" is stale and may not reflect the current design`,
          {
            path: `artifacts[${i}]`,
            artifactPath: artifact.filename,
            artifactType: artifact.fileType,
            remediationHint:
              'Re-export this artifact to ensure it reflects the latest design changes',
            details: { stale: true },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: checksum mismatch ─────────────────────────────────────────────────

function checkChecksumMismatches(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  for (const [i, artifact] of input.artifacts.entries()) {
    if (
      artifact.checksum !== undefined &&
      artifact.checksum !== null &&
      artifact.checksum.trim().length > 0 &&
      artifact.checksum.includes(':') // format: "expected:actual" for comparison
    ) {
      const parts = artifact.checksum.split(':');
      const expected = parts[0];
      const actual = parts[1];
      if (expected && actual && expected !== actual) {
        issues.push(
          manifestError(
            ExportManifestCode.CHECKSUM_MISMATCH,
            `Checksum mismatch for "${artifact.filename}": expected ${expected}, got ${actual}`,
            {
              path: `artifacts[${i}]`,
              artifactPath: artifact.filename,
              remediationHint: 'Re-export the file or verify the source file integrity',
              details: {
                expectedChecksum: expected,
                actualChecksum: actual,
              },
            },
          ),
        );
      }
    }
  }

  return issues;
}

// ── Rule: missing required files ────────────────────────────────────────────

function checkMissingRequiredFiles(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  if (!input.expectedArtifacts || input.expectedArtifacts.length === 0) {
    return issues;
  }

  const exportedNames = new Set(input.artifacts.map((a) => a.filename));

  for (const [i, expected] of input.expectedArtifacts.entries()) {
    const isRequired = expected.required ?? true; // default to required
    if (isRequired && !exportedNames.has(expected.filename)) {
      issues.push(
        manifestError(
          ExportManifestCode.MISSING_REQUIRED_FILE,
          `Required artifact "${expected.filename}" (${expected.fileType}) was not found in the export output`,
          {
            path: `expectedArtifacts[${i}]`,
            artifactType: expected.fileType,
            remediationHint: 'Re-run the export to ensure all required files are generated',
            details: {
              expectedFilename: expected.filename,
              expectedFileType: expected.fileType,
            },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: unexpected files ──────────────────────────────────────────────────

function checkUnexpectedFiles(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  if (!input.expectedArtifacts || input.expectedArtifacts.length === 0) {
    return issues;
  }

  const expectedNames = new Set(input.expectedArtifacts.map((a) => a.filename));

  for (const [i, artifact] of input.artifacts.entries()) {
    if (!expectedNames.has(artifact.filename)) {
      issues.push(
        manifestWarning(
          ExportManifestCode.UNEXPECTED_FILE,
          `Unexpected artifact "${artifact.filename}" was found but is not listed in expected artifacts`,
          {
            path: `artifacts[${i}]`,
            artifactPath: artifact.filename,
            artifactType: artifact.fileType,
            remediationHint:
              'Either add this file to the expected artifact list or verify it is intentionally included',
            details: { filename: artifact.filename },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: wrong file type ───────────────────────────────────────────────────

function checkWrongFileTypes(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];

  if (!input.expectedArtifacts || input.expectedArtifacts.length === 0) {
    return issues;
  }

  // Build a map of expected file types by filename
  const expectedTypeByFile = new Map<string, string>();
  for (const expected of input.expectedArtifacts) {
    expectedTypeByFile.set(expected.filename, expected.fileType);
  }

  for (const [i, artifact] of input.artifacts.entries()) {
    const expectedType = expectedTypeByFile.get(artifact.filename);
    if (expectedType && artifact.fileType !== expectedType) {
      issues.push(
        manifestError(
          ExportManifestCode.WRONG_FILE_TYPE,
          `Artifact "${artifact.filename}" has type "${artifact.fileType}" but expected "${expectedType}"`,
          {
            path: `artifacts[${i}]`,
            artifactPath: artifact.filename,
            artifactType: artifact.fileType,
            remediationHint:
              'Check the export configuration — the file may have been assigned the wrong format',
            details: {
              actualType: artifact.fileType,
              expectedType,
            },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: required artifact metadata ────────────────────────────────────────

function checkRequiredArtifactMetadata(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];
  const policy = input.manufacturingPolicy;

  if (!policy) return issues;

  for (const [i, artifact] of input.artifacts.entries()) {
    if (!artifact.required) continue;

    if (policy.requireChecksums && (!artifact.checksum || artifact.checksum.trim().length === 0)) {
      issues.push(
        manifestError(
          ExportManifestCode.MISSING_CHECKSUM,
          `Required artifact "${artifact.filename}" is missing checksum metadata`,
          {
            path: `artifacts[${i}].checksum`,
            artifactPath: artifact.filename,
            artifactType: artifact.fileType,
            remediationHint:
              'Compute and store a SHA-256 checksum for every required export artifact before manufacturing handoff',
          },
        ),
      );
    }

    if (policy.requireChecksums && artifact.checksum && !artifact.checksumAlgorithm) {
      issues.push(
        manifestWarning(
          ExportManifestCode.MISSING_CHECKSUM,
          `Artifact "${artifact.filename}" has a checksum but no checksumAlgorithm`,
          {
            path: `artifacts[${i}].checksumAlgorithm`,
            artifactPath: artifact.filename,
            artifactType: artifact.fileType,
            remediationHint: 'Set checksumAlgorithm to sha256, sha512, or md5; sha256 is preferred',
          },
        ),
      );
    }

    if (policy.requireFileSizes && artifact.fileSize === undefined) {
      issues.push(
        manifestError(
          ExportManifestCode.MISSING_FILE_SIZE,
          `Required artifact "${artifact.filename}" is missing fileSize metadata`,
          {
            path: `artifacts[${i}].fileSize`,
            artifactPath: artifact.filename,
            artifactType: artifact.fileType,
            remediationHint:
              'Record the actual file size from disk so empty/truncated package artifacts can be detected',
          },
        ),
      );
    }

    if (policy.requireGenerationMetadata) {
      const missingFields = [
        !artifact.generatedByTool ? 'generatedByTool' : undefined,
        !artifact.timestamp ? 'timestamp' : undefined,
        !artifact.sourceProject ? 'sourceProject' : undefined,
      ].filter((field): field is string => Boolean(field));

      if (missingFields.length > 0) {
        issues.push(
          manifestError(
            ExportManifestCode.MISSING_GENERATION_METADATA,
            `Required artifact "${artifact.filename}" is missing generation metadata: ${missingFields.join(', ')}`,
            {
              path: `artifacts[${i}]`,
              artifactPath: artifact.filename,
              artifactType: artifact.fileType,
              remediationHint:
                'Record sourceProject, generatedByTool, and timestamp for every required artifact so the package is reproducible and auditable',
              details: { missingFields },
            },
          ),
        );
      }
    }
  }

  return issues;
}

// ── Rule: expected role mismatch ────────────────────────────────────────────

function checkExpectedRoles(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];
  if (!input.expectedArtifacts || input.expectedArtifacts.length === 0) return issues;

  const artifactByFilename = new Map(
    input.artifacts.map((artifact) => [artifact.filename, artifact]),
  );

  for (const [i, expected] of input.expectedArtifacts.entries()) {
    if (!expected.role) continue;
    const artifact = artifactByFilename.get(expected.filename);
    if (!artifact) continue;
    if (artifact.role !== expected.role) {
      issues.push(
        manifestError(
          ExportManifestCode.MISSING_REQUIRED_ROLE,
          `Artifact "${expected.filename}" has role "${artifact.role ?? '<missing>'}" but expected "${expected.role}"`,
          {
            path: `expectedArtifacts[${i}].role`,
            artifactPath: expected.filename,
            artifactType: expected.fileType,
            remediationHint:
              'Assign the correct manufacturing role to the artifact so package completeness checks can reason about layers and assembly outputs',
            details: { actualRole: artifact.role, expectedRole: expected.role },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: manufacturing required roles ──────────────────────────────────────

function checkManufacturingRoles(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];
  const requiredRoles = input.manufacturingPolicy?.requiredRoles ?? [];
  if (requiredRoles.length === 0) return issues;

  const presentRoles = new Set(input.artifacts.map((artifact) => artifact.role).filter(Boolean));

  for (const requiredRole of requiredRoles) {
    if (presentRoles.has(requiredRole)) continue;

    let code: ExportManifestCode = ExportManifestCode.MISSING_REQUIRED_ROLE;
    let message = `Required manufacturing artifact role "${requiredRole}" is missing from the export package`;
    let hint =
      'Re-run the export or add the missing artifact to the package manifest before manufacturing handoff';

    if (requiredRole === ExportArtifactRole.BoardOutline) {
      code = ExportManifestCode.MISSING_BOARD_OUTLINE;
      message = 'Board outline artifact is missing from the manufacturing export package';
      hint =
        'Export the board outline/mechanical layer; fabrication packages without a board outline should not be handed off';
    } else if (
      requiredRole === ExportArtifactRole.DrillPlated ||
      requiredRole === ExportArtifactRole.DrillNonPlated
    ) {
      code = ExportManifestCode.MISSING_DRILL_FILE;
      message = `Required drill artifact role "${requiredRole}" is missing from the manufacturing export package`;
      hint =
        'Export the required NC drill file and verify it is non-empty before fabrication handoff';
    }

    issues.push(
      manifestError(code, message, {
        path: 'manufacturingPolicy.requiredRoles',
        artifactType: requiredRole,
        remediationHint: hint,
        details: { requiredRole },
      }),
    );

    if (code !== ExportManifestCode.MISSING_REQUIRED_ROLE) {
      issues.push(
        manifestError(
          ExportManifestCode.MISSING_REQUIRED_ROLE,
          `Required manufacturing artifact role "${requiredRole}" is missing from the export package`,
          {
            path: 'manufacturingPolicy.requiredRoles',
            artifactType: requiredRole,
            remediationHint: hint,
            details: { requiredRole },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: project / EasyEDA metadata ────────────────────────────────────────

function checkProjectMetadata(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];
  if (!input.manufacturingPolicy?.requireProjectMetadata) return issues;

  const metadata = input.projectMetadata;
  const missingFields = [
    !metadata?.projectId ? 'projectMetadata.projectId' : undefined,
    !metadata?.projectName && !input.sourceProjectName ? 'projectMetadata.projectName' : undefined,
    !metadata?.easyedaVersion ? 'projectMetadata.easyedaVersion' : undefined,
    !metadata?.bridgeVersion ? 'projectMetadata.bridgeVersion' : undefined,
    !input.serverVersion ? 'serverVersion' : undefined,
  ].filter((field): field is string => Boolean(field));

  if (missingFields.length > 0) {
    issues.push(
      manifestError(
        ExportManifestCode.MISSING_PROJECT_METADATA,
        `Manufacturing manifest is missing required project/EasyEDA metadata: ${missingFields.join(', ')}`,
        {
          path: 'projectMetadata',
          remediationHint:
            'Attach EasyEDA version, bridge version, server version, project id, and project name to the manifest before releasing manufacturing files',
          details: { missingFields },
        },
      ),
    );
  }

  return issues;
}

// ── Rule: BOM / pick-and-place consistency ──────────────────────────────────

function normalizeDesignator(value: string): string {
  return value.trim().toUpperCase();
}

function checkBomPnpConsistency(input: ExportManifestInput): ExportManifestIssue[] {
  const issues: ExportManifestIssue[] = [];
  const consistency = input.assemblyConsistency;
  if (!input.manufacturingPolicy?.requireBomPnpConsistency && !consistency) return issues;

  const artifactsByRole = new Set(input.artifacts.map((artifact) => artifact.role).filter(Boolean));
  const hasBom = artifactsByRole.has(ExportArtifactRole.Bom);
  const hasPnp = artifactsByRole.has(ExportArtifactRole.PickPlace);

  if (input.manufacturingPolicy?.requireBomPnpConsistency && (!hasBom || !hasPnp)) {
    const missing = [
      !hasBom ? ExportArtifactRole.Bom : undefined,
      !hasPnp ? ExportArtifactRole.PickPlace : undefined,
    ].filter((role): role is ExportArtifactRole => Boolean(role));
    issues.push(
      manifestError(
        ExportManifestCode.BOM_PNP_MISMATCH,
        `BOM / pick-and-place consistency was requested but package is missing: ${missing.join(', ')}`,
        {
          path: 'artifacts',
          remediationHint:
            'Export both BOM and pick-and-place files before running assembly consistency checks',
          details: { missingRoles: missing },
        },
      ),
    );
  }

  if (!consistency) return issues;

  const bomDesignators = new Set((consistency.bomDesignators ?? []).map(normalizeDesignator));
  const pnpDesignators = new Set((consistency.pnpDesignators ?? []).map(normalizeDesignator));

  if (
    consistency.expectedBomDesignatorCount !== undefined &&
    bomDesignators.size !== consistency.expectedBomDesignatorCount
  ) {
    issues.push(
      manifestError(
        ExportManifestCode.BOM_PNP_MISMATCH,
        `BOM designator count mismatch: expected ${consistency.expectedBomDesignatorCount}, got ${bomDesignators.size}`,
        {
          path: 'assemblyConsistency.expectedBomDesignatorCount',
          remediationHint:
            'Regenerate the BOM or update the expected designator count from the exported file parser',
          details: {
            expected: consistency.expectedBomDesignatorCount,
            actual: bomDesignators.size,
          },
        },
      ),
    );
  }

  if (
    consistency.expectedPnpDesignatorCount !== undefined &&
    pnpDesignators.size !== consistency.expectedPnpDesignatorCount
  ) {
    issues.push(
      manifestError(
        ExportManifestCode.BOM_PNP_MISMATCH,
        `Pick-and-place designator count mismatch: expected ${consistency.expectedPnpDesignatorCount}, got ${pnpDesignators.size}`,
        {
          path: 'assemblyConsistency.expectedPnpDesignatorCount',
          remediationHint:
            'Regenerate the pick-and-place file or update the expected designator count from the exported file parser',
          details: {
            expected: consistency.expectedPnpDesignatorCount,
            actual: pnpDesignators.size,
          },
        },
      ),
    );
  }

  const missingFromBom = [...pnpDesignators].filter(
    (designator) => !bomDesignators.has(designator),
  );
  if (missingFromBom.length > 0) {
    issues.push(
      manifestError(
        ExportManifestCode.BOM_PNP_MISMATCH,
        `Pick-and-place contains designators not present in BOM: ${missingFromBom.join(', ')}`,
        {
          path: 'assemblyConsistency.pnpDesignators',
          remediationHint:
            'Ensure every placed assembly designator is represented in the BOM, or explicitly mark non-BOM mechanical/fiducial rows as excluded before handoff',
          details: { missingFromBom },
        },
      ),
    );
  }

  return issues;
}

// ── Combine helper ──────────────────────────────────────────────────────────

type RuleFn = (input: ExportManifestInput) => ExportManifestIssue[];

const RULES: RuleFn[] = [
  checkManifestVersion,
  checkSourceProject,
  checkGeneratedTimestamps,
  checkMissingPurposes,
  checkEmptyFiles,
  checkStaleFiles,
  checkChecksumMismatches,
  checkMissingRequiredFiles,
  checkUnexpectedFiles,
  checkWrongFileTypes,
  checkRequiredArtifactMetadata,
  checkExpectedRoles,
  checkManufacturingRoles,
  checkProjectMetadata,
  checkBomPnpConsistency,
];

// ── Summary builder ─────────────────────────────────────────────────────────

function buildSummary(
  issues: ExportManifestIssue[],
  input: ExportManifestInput,
): ExportManifestSummary {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  return {
    totalFiles: input.artifacts.length,
    errors,
    warnings,
    missingRequired: issues.filter((i) => i.code === ExportManifestCode.MISSING_REQUIRED_FILE)
      .length,
    emptyFiles: issues.filter((i) => i.code === ExportManifestCode.EMPTY_FILE).length,
    staleFiles: issues.filter((i) => i.code === ExportManifestCode.STALE_FILE).length,
    checksumMismatches: issues.filter((i) => i.code === ExportManifestCode.CHECKSUM_MISMATCH)
      .length,
    unexpectedFiles: issues.filter((i) => i.code === ExportManifestCode.UNEXPECTED_FILE).length,
    wrongFileTypes: issues.filter((i) => i.code === ExportManifestCode.WRONG_FILE_TYPE).length,
    missingPurposes: issues.filter((i) => i.code === ExportManifestCode.MISSING_PURPOSE).length,
    missingTimestamps: issues.filter(
      (i) => i.code === ExportManifestCode.MISSING_GENERATED_TIMESTAMP,
    ).length,
    missingSourceProjects: issues.filter(
      (i) => i.code === ExportManifestCode.MISSING_SOURCE_PROJECT,
    ).length,
    missingChecksums: issues.filter((i) => i.code === ExportManifestCode.MISSING_CHECKSUM).length,
    missingFileSizes: issues.filter((i) => i.code === ExportManifestCode.MISSING_FILE_SIZE).length,
    missingRequiredRoles: issues.filter((i) => i.code === ExportManifestCode.MISSING_REQUIRED_ROLE)
      .length,
    missingBoardOutlines: issues.filter((i) => i.code === ExportManifestCode.MISSING_BOARD_OUTLINE)
      .length,
    missingDrillFiles: issues.filter((i) => i.code === ExportManifestCode.MISSING_DRILL_FILE)
      .length,
    bomPnpMismatches: issues.filter((i) => i.code === ExportManifestCode.BOM_PNP_MISMATCH).length,
    missingProjectMetadata: issues.filter(
      (i) => i.code === ExportManifestCode.MISSING_PROJECT_METADATA,
    ).length,
  };
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run all export manifest validation rules against an input manifest.
 *
 * Orchestrates 10 rules:
 *  1. Invalid manifest version   — error if version is not valid semver
 *  2. Missing source project     — error if sourceProjectId is empty
 *                                — warning per artifact without sourceProject
 *  3. Missing generated timestamp— error if generatedAt is empty
 *                                — warning per artifact without timestamp
 *  4. Missing purpose            — warning per artifact without purpose
 *  5. Empty file                 — error per artifact with fileSize === 0
 *  6. Stale file                 — warning per artifact with stale === true
 *  7. Checksum mismatch          — error when checksum "expected:actual" differs
 *  8. Missing required file      — error when expected artifact not in output
 *  9. Unexpected file            — warning when output file not in expected set
 * 10. Wrong file type            — error when artifact type !== expected type
 * 11. Required metadata        — error when manufacturing policy requires missing checksums, sizes, or generation metadata
 * 12. Manufacturing roles      — error when required board outline, drill, layer, BOM, or pick-place roles are missing
 * 13. Project metadata         — error when EasyEDA/project metadata required by policy is absent
 * 14. BOM/PNP consistency      — error when assembly designator data is inconsistent
 */
export function validateExportManifest(input: ExportManifestInput): ExportManifestReport {
  const issues: ExportManifestIssue[] = [];

  for (const rule of RULES) {
    const ruleIssues = rule(input);
    issues.push(...ruleIssues);
  }

  const errors = issues.filter((i) => i.severity === 'error').length;

  return {
    valid: errors === 0,
    manifest: input,
    issues,
    summary: buildSummary(issues, input),
  };
}
