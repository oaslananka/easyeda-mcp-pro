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
