/**
 * Export manifest — public API barrel export.
 *
 * @module
 */

export { ArtifactType, ExportArtifactRole } from './types.js';
export type {
  ExportManifestEntry,
  ExpectedArtifact,
  ExportProjectMetadata,
  AssemblyConsistencyMetadata,
  ManufacturingExportPolicy,
  ExportManifestInput,
  ExportManifestIssue,
  ExportManifestSummary,
  ExportManifestReport,
} from './types.js';

export { ExportManifestCode, manifestIssue, manifestError, manifestWarning } from './errors.js';
export type { ExportManifestCode as ExportManifestCodeType } from './errors.js';

export { validateExportManifest } from './validation.js';
