/**
 * Export manifest — error codes, structured issues, and factories.
 *
 * Follows the same pattern as `net-validation/errors.ts`:
 * a const-object error code enum, a structured issue interface
 * (re-exported from types.ts), and factory helpers.
 *
 * @module
 */

import type { ExportManifestIssue } from './types.js';

// ── Error codes ─────────────────────────────────────────────────────────────

export const ExportManifestCode = {
  // ── Completeness errors ────────────────────────────────────────────────

  /** A required artifact file was not found in the export output. */
  MISSING_REQUIRED_FILE: 'MISSING_REQUIRED_FILE',
  /** An artifact file exists but has zero bytes. */
  EMPTY_FILE: 'EMPTY_FILE',
  /** An artifact is flagged as stale (outdated). */
  STALE_FILE: 'STALE_FILE',
  /** An artifact appears in the output but was not in the expected set. */
  UNEXPECTED_FILE: 'UNEXPECTED_FILE',

  // ── Integrity errors ───────────────────────────────────────────────────

  /** Artifact checksum does not match the expected value. */
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  /** Artifact's declared file type does not match its content/name. */
  WRONG_FILE_TYPE: 'WRONG_FILE_TYPE',

  /** Required artifact is missing checksum metadata. */
  MISSING_CHECKSUM: 'MISSING_CHECKSUM',
  /** Required artifact is missing file size metadata. */
  MISSING_FILE_SIZE: 'MISSING_FILE_SIZE',
  /** Required artifact is missing generation metadata. */
  MISSING_GENERATION_METADATA: 'MISSING_GENERATION_METADATA',
  /** Required manufacturing artifact role is missing from the package. */
  MISSING_REQUIRED_ROLE: 'MISSING_REQUIRED_ROLE',
  /** Board outline artifact is missing or invalid. */
  MISSING_BOARD_OUTLINE: 'MISSING_BOARD_OUTLINE',
  /** Drill artifact is missing or invalid. */
  MISSING_DRILL_FILE: 'MISSING_DRILL_FILE',
  /** BOM and pick-and-place designators are inconsistent. */
  BOM_PNP_MISMATCH: 'BOM_PNP_MISMATCH',
  /** Manifest lacks required project / EasyEDA metadata. */
  MISSING_PROJECT_METADATA: 'MISSING_PROJECT_METADATA',

  // ── Metadata errors ────────────────────────────────────────────────────

  /** Artifact is missing a human-readable purpose description. */
  MISSING_PURPOSE: 'MISSING_PURPOSE',
  /** Artifact is missing a generation timestamp. */
  MISSING_GENERATED_TIMESTAMP: 'MISSING_GENERATED_TIMESTAMP',
  /** Artifact is missing a source project reference. */
  MISSING_SOURCE_PROJECT: 'MISSING_SOURCE_PROJECT',

  // ── Schema errors ──────────────────────────────────────────────────────

  /** Manifest version string is not valid semver. */
  INVALID_MANIFEST_VERSION: 'INVALID_MANIFEST_VERSION',

  // ── Internal ───────────────────────────────────────────────────────────

  /** Validation could not be completed due to an internal error. */
  MANIFEST_INTERNAL: 'MANIFEST_INTERNAL',
} as const;

export type ExportManifestCode = (typeof ExportManifestCode)[keyof typeof ExportManifestCode];

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a single export manifest issue.
 */
export function manifestIssue(
  code: ExportManifestCode,
  message: string,
  opts?: {
    severity?: 'error' | 'warning';
    path?: string;
    artifactPath?: string;
    artifactType?: string;
    purpose?: string;
    remediationHint?: string;
    details?: Record<string, unknown>;
  },
): ExportManifestIssue {
  return {
    code,
    message,
    severity: opts?.severity ?? 'error',
    path: opts?.path,
    artifactPath: opts?.artifactPath,
    artifactType: opts?.artifactType,
    purpose: opts?.purpose,
    remediationHint: opts?.remediationHint ?? '',
    details: opts?.details,
  };
}

/**
 * Convenience: create an error-severity issue.
 */
export function manifestError(
  code: ExportManifestCode,
  message: string,
  opts?: Omit<Parameters<typeof manifestIssue>[2], 'severity'>,
): ExportManifestIssue {
  return manifestIssue(code, message, { ...opts, severity: 'error' });
}

/**
 * Convenience: create a warning-severity issue.
 */
export function manifestWarning(
  code: ExportManifestCode,
  message: string,
  opts?: Omit<Parameters<typeof manifestIssue>[2], 'severity'>,
): ExportManifestIssue {
  return manifestIssue(code, message, { ...opts, severity: 'warning' });
}
