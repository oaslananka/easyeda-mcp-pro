# Export Manifest

> Manifest schema, artifact type reference, and validation rules for export
> integrity checking.

## Overview

The export manifest is a structured metadata document generated alongside export
artifacts. It describes what was exported, when, by which tool, and enables
automated validation of completeness and integrity.

**Purpose:**

- Verify that all required export files were generated
- Detect empty, stale, or corrupted artifacts
- Track which tool version produced each artifact
- Enable CI-safe validation without a live EasyEDA Pro instance
- Provide a machine-readable audit trail for manufacturing handoff

## Manifest Schema

```typescript
interface ExportManifestInput {
  version: string; // Manifest schema version (semver)
  sourceProjectId: string; // EasyEDA project UUID
  sourceProjectName?: string; // Human-readable project name
  generatedAt: string; // ISO-8601 generation timestamp
  serverVersion?: string; // Server/tool version
  bridgeMetadata?: Record<string, unknown>; // EasyEDA bridge metadata
  projectMetadata?: ExportProjectMetadata; // project / EasyEDA version metadata
  manufacturingPolicy?: ManufacturingExportPolicy; // strict handoff checks
  assemblyConsistency?: AssemblyConsistencyMetadata; // BOM / PNP cross-check data
  artifacts: ExportManifestEntry[]; // Exported files
  expectedArtifacts?: ExpectedArtifact[]; // Expected file descriptors
}
```

### Artifact Entry

```typescript
interface ExportManifestEntry {
  filename: string; // File name (e.g. "ESP32-Board-F.Cu.gbr")
  relativePath?: string; // Path relative to export root
  fileType: ArtifactType; // Type (gerber, drill, bom, etc.)
  purpose: string; // Human-readable description
  role?: ExportArtifactRole; // Manufacturing role, e.g. board-outline
  sourceProject?: string; // Project UUID this artifact came from
  generatedByTool?: string; // Tool name (e.g. "easyeda-export-gerbers")
  timestamp?: string; // ISO-8601 generation time
  checksum?: string; // SHA-256, SHA-512, or MD5 checksum
  checksumAlgorithm?: 'sha256' | 'sha512' | 'md5';
  fileSize?: number; // Size in bytes
  required: boolean; // Whether this file is required
  stale: boolean; // Whether this artifact is outdated
}
```

### Expected Artifact

```typescript
interface ExpectedArtifact {
  filename: string; // Expected file name
  fileType: ArtifactType; // Expected file type
  role?: ExportArtifactRole; // Expected manufacturing role
  minSizeBytes?: number; // Minimum acceptable size
  required?: boolean; // Whether missing = error (default: true)
}
```

## Artifact Types

| Enum Value   | Description                       | Example Extension |
| ------------ | --------------------------------- | ----------------- |
| `gerber`     | Gerber RS-274X fabrication layer  | `.gbr`            |
| `drill`      | NC drill file (Excellon format)   | `.drl`            |
| `bom`        | Bill of materials (CSV)           | `.csv`            |
| `pnp`        | Pick-and-place / centroid file    | `.csv`            |
| `pdf`        | PDF export (schematic or board)   | `.pdf`            |
| `netlist`    | Netlist (PADS / Allegro / Altium) | `.txt`, `.asc`    |
| `erc-report` | Electrical rules check report     | `.txt`, `.json`   |
| `drc-report` | Design rules check report         | `.txt`, `.json`   |

## Validation Rules

The module runs structural and manufacturing handoff validation rules against an `ExportManifestInput`:

| #   | Rule                        | Severity | Description                                                       |
| --- | --------------------------- | -------- | ----------------------------------------------------------------- |
| 1   | Invalid version             | error    | Manifest version must be valid semver (e.g. `1.0.0`)              |
| 2   | Missing source project      | error    | `sourceProjectId` must be non-empty                               |
|     |                             | warning  | Each artifact should have `sourceProject`                         |
| 3   | Missing timestamp           | error    | `generatedAt` must be non-empty                                   |
|     |                             | warning  | Each artifact should have `timestamp`                             |
| 4   | Missing purpose             | warning  | Each artifact should have a human-readable `purpose`              |
| 5   | Empty file                  | error    | Artifacts with `fileSize: 0` are rejected                         |
| 6   | Stale file                  | warning  | Artifacts flagged `stale: true` need re-export                    |
| 7   | Checksum mismatch           | error    | When `checksum` uses `"expected:actual"` format and values differ |
| 8   | Missing required file       | error    | Required `expectedArtifacts` not found in `artifacts`             |
| 9   | Unexpected file             | warning  | Artifact in output but not in `expectedArtifacts`                 |
| 10  | Wrong file type             | error    | Artifact `fileType` doesn't match `expectedArtifacts` entry       |
| 11  | Missing checksum            | error    | Required artifact lacks checksum when strict policy requires it   |
| 12  | Missing file size           | error    | Required artifact lacks file size metadata                        |
| 13  | Missing generation metadata | error    | Required artifact lacks source/tool/timestamp metadata            |
| 14  | Missing required role       | error    | Required manufacturing role is absent                             |
| 15  | Missing board outline       | error    | Board outline/mechanical artifact is absent                       |
| 16  | Missing drill file          | error    | Required NC drill artifact is absent                              |
| 17  | BOM/PNP mismatch            | error    | Pick-and-place designators are not represented in BOM             |
| 18  | Missing project metadata    | error    | EasyEDA/project/server metadata is absent in strict policy        |

### Validation Report

```typescript
interface ExportManifestReport {
  valid: boolean; // True if zero errors
  manifest: ExportManifestInput; // The validated manifest
  issues: ExportManifestIssue[]; // All issues found
  summary: ExportManifestSummary; // Aggregated counts
}

interface ExportManifestSummary {
  totalFiles: number;
  errors: number;
  warnings: number;
  missingRequired: number;
  emptyFiles: number;
  staleFiles: number;
  checksumMismatches: number;
  unexpectedFiles: number;
  wrongFileTypes: number;
  missingPurposes: number;
  missingTimestamps: number;
  missingSourceProjects: number;
  missingChecksums: number;
  missingFileSizes: number;
  missingRequiredRoles: number;
  missingBoardOutlines: number;
  missingDrillFiles: number;
  bomPnpMismatches: number;
  missingProjectMetadata: number;
}
```

## Usage

### Validating a manifest

```typescript
import { validateExportManifest } from './export-manifest/validation.js';

const result = validateExportManifest({
  version: '1.0.0',
  sourceProjectId: 'proj-abc-123',
  generatedAt: '2026-06-11T21:00:00.000Z',
  artifacts: [/* ... entries ... */],
  expectedArtifacts: [/* ... expectations ... */],
});

if (!result.valid) {
  console.error('Export validation failed:', result.summary);
  for (const issue of result.issues) {
    console.error(`  [${issue.severity}] ${issue.message}`);
  }
}
```

### Creating artifact entries

```typescript
import { ArtifactType } from './export-manifest/types.js';

const entry = {
  filename: 'ESP32-S3-Board-F.Cu.gbr',
  fileType: ArtifactType.Gerber,
  purpose: 'Top copper layer',
  sourceProject: 'proj-abc-123',
  generatedByTool: 'easyeda-export-gerbers',
  timestamp: new Date().toISOString(),
  fileSize: 4096,
  required: true,
  stale: false,
};
```

## Manufacturing Handoff Policy

For fabrication/assembly packages, pass a strict `manufacturingPolicy` so the manifest validator can block incomplete packages before handoff:

```typescript
import {
  ArtifactType,
  ExportArtifactRole,
  validateExportManifest,
} from 'easyeda-mcp-pro/export-manifest';

const result = validateExportManifest({
  version: '1.0.0',
  sourceProjectId: 'proj-abc-123',
  sourceProjectName: 'Regulator Board',
  generatedAt: new Date().toISOString(),
  serverVersion: '0.6.10',
  projectMetadata: {
    projectId: 'proj-abc-123',
    projectName: 'Regulator Board',
    easyedaVersion: '3.2.149',
    bridgeVersion: '1.0.0',
    revision: 'A',
  },
  manufacturingPolicy: {
    requiredRoles: [
      ExportArtifactRole.TopCopper,
      ExportArtifactRole.BottomCopper,
      ExportArtifactRole.BoardOutline,
      ExportArtifactRole.DrillPlated,
      ExportArtifactRole.Bom,
      ExportArtifactRole.PickPlace,
    ],
    requireChecksums: true,
    requireFileSizes: true,
    requireGenerationMetadata: true,
    requireProjectMetadata: true,
    requireBomPnpConsistency: true,
  },
  assemblyConsistency: {
    bomDesignators: ['R1', 'C1', 'U1'],
    pnpDesignators: ['R1', 'C1', 'U1'],
  },
  artifacts: [
    {
      filename: 'board-Edge.Cuts.gbr',
      fileType: ArtifactType.Gerber,
      role: ExportArtifactRole.BoardOutline,
      purpose: 'Board outline',
      sourceProject: 'proj-abc-123',
      generatedByTool: 'easyeda-export-gerbers',
      timestamp: new Date().toISOString(),
      checksum: '<sha256>',
      checksumAlgorithm: 'sha256',
      fileSize: 4096,
      required: true,
      stale: false,
    },
  ],
});
```

Strict policy blocks handoff when:

- required copper, outline, drill, BOM, or pick-and-place roles are missing;
- required artifacts lack checksum, file size, source, tool, or timestamp metadata;
- EasyEDA/project/server metadata is missing;
- pick-and-place contains assembly designators that are not represented in the BOM.

## CI-Safe Fixture Workflow

The validation module is designed to run without a live EasyEDA Pro instance.
Tests use fixture JSON files in `tests/fixtures/export-manifest/`:

```
tests/fixtures/export-manifest/
├── valid-manifest.json           # 6 artifacts, all correct
├── missing-required-file.json    # Missing expected gerber
├── empty-file.json               # Artifact with 0 bytes
├── stale-file.json               # Artifact flagged stale
├── checksum-mismatch.json        # Checksum expected:actual differs
├── wrong-file-type.json          # File type mismatch
├── invalid-version.json          # Bad semver
└── missing-metadata.json         # Empty source/timestamp/purpose
```

To add a new fixture:

1. Create a JSON file following the `ExportManifestInput` schema
2. Add a test that loads and validates it
3. Run `pnpm test` to confirm expected pass/fail behavior

## Manual EasyEDA Pro Export Workflow

When using EasyEDA Pro with the bridge extension:

1. Export Gerbers, BOM, PDF, etc. via the existing MCP tools
2. The export response includes `artifact_path` and `file_count`
3. Create a manifest object from the export results and any file system scan
4. Run `validateExportManifest()` to check completeness
5. Review warnings (stale files, unexpected files, missing metadata)
6. Fix errors (missing required files, empty files, checksum mismatches)

## Checksum Update Process

1. Export artifacts using your EDA tool
2. Compute checksums: `sha256sum <file>` (Linux/macOS) or `Get-FileHash <file>` (PowerShell)
3. Include checksums in the artifact entries
4. For comparison, use the `"expected:actual"` format — the module splits on `:`
   and reports mismatch when the two values differ
5. Update expected checksums in your test fixtures when source designs change

## Integration with Golden Fixture

The golden fixture in `tests/fixtures/golden/fixture.json` already includes an
`exportManifest` section with expected file counts, formats, and file-level
expectations. The `golden-smoke.test.ts` suite verifies:

- Expected file count matches
- Required formats are present (gerber, drill, bom_csv, pnp_csv, pdf_schematic, pdf_board, netlist)
- All filenames are unique
- Each file meets its `minSizeBytes` threshold

## Known Limitations

- **Checksum format**: The `"expected:actual"` convention is ad-hoc. A structured
  `{ expectedChecksum: string, actualChecksum: string }` field would be cleaner but
  is deferred for schema compatibility.
- **No real file I/O**: The module validates the manifest structure and metadata only — it does
  not read actual files from disk to verify sizes, existence, or checksums.
  Export callers must pass the actual values obtained from the file system or export response.
- **Semver strictness**: The version regex allows pre-release tags but does not
  support build metadata (`+` suffix). Extend `SEMVER_RE` in `validation.ts` if needed.
- **No cross-artifact deduplication**: If the same filename appears in multiple
  artifact entries, each is validated independently. Deduplication is caller responsibility.
- **Bridge-dependent fields**: `bridgeMetadata` is recorded if available but not
  validated — the module assumes the bridge provides accurate metadata.

## Production QA roles

Production QA handoff artifacts can be modeled as documentation artifacts in the manifest:

| Role                      | Artifact type   | Purpose                                         |
| ------------------------- | --------------- | ----------------------------------------------- |
| `testpoint-checklist`     | `documentation` | Critical-net test access checklist              |
| `assembly-notes`          | `documentation` | Polarity, DNP, side, and special handling notes |
| `bringup-plan`            | `documentation` | Bench bring-up and rail verification plan       |
| `production-qa-checklist` | `documentation` | Operator-facing production QA checklist         |
| `qa-manifest`             | `documentation` | Machine-readable QA package                     |

Add these roles to `manufacturingPolicy.requiredRoles` when production test and assembly notes must be part of the export package.
