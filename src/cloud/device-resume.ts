import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ManagedExtensionSession } from '../remote/session-router.js';

/** Hosted-only, owner-scoped device association, never a tool authorization. */
export class HostedDeviceResumeStore {
  private static readonly ttlMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS "hostedDeviceResume" (' +
        '"deviceId" TEXT PRIMARY KEY, "userId" TEXT NOT NULL,' +
        '"sessionId" TEXT NOT NULL UNIQUE, "credentialHash" TEXT NOT NULL UNIQUE,' +
        '"extensionVersion" TEXT NOT NULL, "lastSeenAt" INTEGER NOT NULL,' +
        '"expiresAt" INTEGER NOT NULL, "revokedAt" INTEGER)',
    );
    database.exec(
      'CREATE INDEX IF NOT EXISTS "hostedDeviceResumeOwner" ' +
        'ON "hostedDeviceResume" ("userId", "expiresAt")',
    );
  }

  private newCredential(): string {
    return 'ers_' + randomBytes(32).toString('hex');
  }

  private hash(credential: string): string {
    return createHash('sha256').update(credential).digest('hex');
  }

  /** Only after separately authenticated, successful one-time owner pairing. */
  issue(userId: string, sessionId: string, extensionVersion: string): string {
    if (!userId || !sessionId || !extensionVersion) {
      throw new Error('A verified owner and session are required.');
    }
    const now = this.now();
    const credential = this.newCredential();
    this.database
      .prepare('DELETE FROM "hostedDeviceResume" WHERE "expiresAt" <= ? OR "revokedAt" IS NOT NULL')
      .run(now);
    this.database
      .prepare(
        'INSERT INTO "hostedDeviceResume" ' +
          '("deviceId", "userId", "sessionId", "credentialHash", "extensionVersion", "lastSeenAt", "expiresAt") ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        userId,
        sessionId,
        this.hash(credential),
        extensionVersion,
        now,
        now + HostedDeviceResumeStore.ttlMs,
      );
    return credential;
  }

  /** Atomic rotation means a consumed credential cannot authenticate twice. */
  redeem(
    credential: string,
    nextSessionId: string,
    extensionVersion: string,
  ): { userId: string; previousSessionId: string; credential: string } | undefined {
    if (!/^ers_[a-f0-9]{64}$/.test(credential) || !nextSessionId || !extensionVersion) return;
    const now = this.now();
    const replacement = this.newCredential();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.database
        .prepare(
          'SELECT "userId", "sessionId" FROM "hostedDeviceResume" ' +
            'WHERE "credentialHash" = ? AND "expiresAt" > ? AND "revokedAt" IS NULL',
        )
        .get(this.hash(credential), now) as { userId: string; sessionId: string } | undefined;
      if (!previous) {
        this.database.exec('COMMIT');
        return undefined;
      }
      const row = this.database
        .prepare(
          'UPDATE "hostedDeviceResume" ' +
            'SET "sessionId" = ?, "credentialHash" = ?, "extensionVersion" = ?, ' +
            '"lastSeenAt" = ?, "expiresAt" = ? ' +
            'WHERE "credentialHash" = ? AND "expiresAt" > ? AND "revokedAt" IS NULL ' +
            'RETURNING "userId"',
        )
        .get(
          nextSessionId,
          this.hash(replacement),
          extensionVersion,
          now,
          now + HostedDeviceResumeStore.ttlMs,
          this.hash(credential),
          now,
        ) as { userId: string } | undefined;
      this.database.exec('COMMIT');
      return row
        ? { userId: row.userId, previousSessionId: previous.sessionId, credential: replacement }
        : undefined;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Persist offline devices so the owner can revoke them after a restart. */
  list(userId: string): ManagedExtensionSession[] {
    const now = this.now();
    const records = this.database
      .prepare(
        'SELECT "sessionId", "extensionVersion", "lastSeenAt", "expiresAt" ' +
          'FROM "hostedDeviceResume" WHERE "userId" = ? AND "expiresAt" > ? AND "revokedAt" IS NULL',
      )
      .all(userId, now) as Array<{
      sessionId: string;
      extensionVersion: string;
      lastSeenAt: number;
      expiresAt: number;
    }>;
    return records.map((row) => ({
      sessionId: row.sessionId,
      mode: 'hosted',
      extensionVersion: row.extensionVersion,
      connected: false,
      lastSeenAt: new Date(row.lastSeenAt),
      expiresAt: new Date(row.expiresAt),
    }));
  }

  revoke(userId: string, sessionId: string): boolean {
    const result = this.database
      .prepare(
        'UPDATE "hostedDeviceResume" SET "revokedAt" = ? ' +
          'WHERE "userId" = ? AND "sessionId" = ? AND "revokedAt" IS NULL',
      )
      .run(this.now(), userId, sessionId);
    return result.changes === 1;
  }
}
