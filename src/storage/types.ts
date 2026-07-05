export interface ProjectCache {
  projectHash: string;
  projectName: string;
  schematicSnapshot: string | null;
  boardSnapshot: string | null;
  bomSnapshot: string | null;
  lastSyncedAt: string;
  easyedaVersion: string | null;
}

export interface ArtifactRecord {
  id: string;
  projectHash: string;
  type: 'gerber' | 'bom' | 'pdf' | 'pick-place' | 'netlist' | 'schematic' | 'board';
  filePath: string;
  createdAt: string;
  metadata: string | null;
}

/**
 * A device ingested and cached locally by the catalog verification pipeline
 * (`easyeda_catalog_verify_device`). `entryJson` is a JSON-serialized
 * `DeviceEntry` (see `src/catalog/schema.ts`); `status` and the counts
 * summarize the most recent `validateDeviceEntry` result so callers can
 * filter without re-parsing/re-validating `entryJson`. Never committed to
 * the repository — local cache only, per `docs/vendor-terms.md`.
 */
export interface VerifiedDeviceRecord {
  lcscId: string;
  entryJson: string;
  status: 'resolved' | 'partial' | 'unresolved';
  errorCount: number;
  warningCount: number;
  createdAt: string;
  updatedAt: string;
}
