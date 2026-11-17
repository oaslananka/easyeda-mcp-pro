import type { RemoteRiskLevel, RemoteScope } from './protocol.js';

export interface RemoteIdentity {
  userId: string;
  /** Verified OAuth client identity; never infer this from an owner ID. */
  clientId?: string;
  scopes: readonly RemoteScope[];
  expiresAt?: Date;
}

export type ScopeCheckResult =
  | { ok: true }
  | { ok: false; code: 'IDENTITY_MISSING' | 'IDENTITY_EXPIRED' | 'SCOPE_MISSING'; message: string };

export function requiredScopeForRisk(riskLevel: RemoteRiskLevel): RemoteScope {
  if (riskLevel === 'read') return 'easyeda.read';
  if (riskLevel === 'write') return 'easyeda.write';
  if (riskLevel === 'export') return 'easyeda.export';
  return 'easyeda.project_admin';
}

export function hasRemoteScope(identity: RemoteIdentity, scope: RemoteScope): boolean {
  return identity.scopes.includes(scope) || identity.scopes.includes('easyeda.project_admin');
}

export function checkRemoteScope(
  identity: RemoteIdentity | undefined,
  riskLevel: RemoteRiskLevel,
  now = new Date(),
): ScopeCheckResult {
  if (!identity)
    return { ok: false, code: 'IDENTITY_MISSING', message: 'Remote identity is required.' };
  if (identity.expiresAt && identity.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, code: 'IDENTITY_EXPIRED', message: 'Remote identity has expired.' };
  }
  const required = requiredScopeForRisk(riskLevel);
  if (!hasRemoteScope(identity, required)) {
    const guidance =
      riskLevel === 'write' || riskLevel === 'export'
        ? ` Reconnect your MCP client requesting ${required}, then approve the new OAuth permissions. Each ${riskLevel} action still needs approval in EasyEDA.`
        : '';
    return {
      ok: false,
      code: 'SCOPE_MISSING',
      message: `Remote tool requires ${required}.${guidance}`,
    };
  }
  return { ok: true };
}
