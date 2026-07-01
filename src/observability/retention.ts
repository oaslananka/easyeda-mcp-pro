/** Storage, cache and artifact retention defaults. */

export interface RetentionPolicy {
  cacheDefaultTtlSeconds: number;
  vendorCacheTtlSeconds: number;
  artifactRetentionDays: number;
  telemetryRetentionDays: number;
  cleanupCadence: 'manual' | 'startup' | 'daily';
  maxArtifactBytes: number;
  notes: string[];
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  cacheDefaultTtlSeconds: 24 * 60 * 60,
  vendorCacheTtlSeconds: 7 * 24 * 60 * 60,
  artifactRetentionDays: 30,
  telemetryRetentionDays: 14,
  cleanupCadence: 'manual',
  maxArtifactBytes: 512 * 1024 * 1024,
  notes: [
    'Cache entries with explicit TTL expire automatically on read.',
    'Artifact cleanup is conservative and should be invoked explicitly before deleting handoff files.',
    'Telemetry snapshots must not contain secrets or raw vendor credentials.',
  ],
};

export function describeRetentionPolicy(
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): string {
  return `Cache TTL ${policy.cacheDefaultTtlSeconds}s, vendor cache TTL ${policy.vendorCacheTtlSeconds}s, artifacts retained ${policy.artifactRetentionDays}d, telemetry retained ${policy.telemetryRetentionDays}d.`;
}
