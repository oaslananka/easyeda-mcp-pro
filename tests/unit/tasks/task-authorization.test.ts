import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { EnvSchema } from '../../../src/config/env.js';
import {
  deriveTrustedReadOnlyTaskPrincipal,
  validateReadOnlyTaskArguments,
  type TaskAuthorizationPolicy,
  type VerifiedOAuthTaskIdentity,
} from '../../../src/tasks/task-authorization.js';

const token: VerifiedOAuthTaskIdentity = {
  kind: 'verified-oauth',
  issuer: 'https://identity.example',
  subject: 'subject-a',
  clientId: 'client-a',
  scopes: ['bom:read', 'pcb:read'],
  expiresAtEpochSeconds: 2000,
};

function fixture(): TaskAuthorizationPolicy {
  const registry = new ToolRegistry();
  registry.setProfile('dev');
  registerBuiltinTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  return { registry, configuredScopes: '*', bridgeBackend: 'local', nowEpochSeconds: () => 1000 };
}

describe('staging Tasks OAuth-derived read-only policy (not production wired)', () => {
  it('derives stable pseudonymous ownership from verified issuer, subject and client', () => {
    const policy = fixture();
    const principal = deriveTrustedReadOnlyTaskPrincipal(token, policy);
    expect(principal?.ownerId).toMatch(/^[a-f0-9]{64}$/);
    expect(principal?.ownerId).not.toContain('subject-a');
    expect([...principal!.allowedOperations].sort()).toEqual([
      'easyeda_bom_generate',
      'easyeda_pcb_components',
    ]);
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['bom:read'] }, policy)?.ownerId,
    ).toBe(principal?.ownerId);
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, subject: 'subject-b' }, policy)?.ownerId,
    ).not.toBe(principal?.ownerId);
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, clientId: 'client-b' }, policy)?.ownerId,
    ).not.toBe(principal?.ownerId);
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, issuer: 'https://other.example' }, policy)
        ?.ownerId,
    ).not.toBe(principal?.ownerId);
  });

  it('fails closed for missing identities, unverified kinds, expired tokens or malformed subject', () => {
    const policy = fixture();
    expect(deriveTrustedReadOnlyTaskPrincipal(undefined, policy)).toBeUndefined();
    expect(
      deriveTrustedReadOnlyTaskPrincipal(
        { ...token, kind: 'unverified' } as unknown as VerifiedOAuthTaskIdentity,
        policy,
      ),
    ).toBeUndefined();
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, expiresAtEpochSeconds: 1000 }, policy),
    ).toBeUndefined();
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, subject: ' owner ' }, policy),
    ).toBeUndefined();
    expect(deriveTrustedReadOnlyTaskPrincipal({ ...token, issuer: '' }, policy)).toBeUndefined();
    expect(deriveTrustedReadOnlyTaskPrincipal({ ...token, clientId: '' }, policy)).toBeUndefined();
    expect(deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: [] }, policy)).toBeUndefined();
  });

  it('intersects token read scopes with the actual configured server scopes', () => {
    const policy = fixture();
    expect([
      ...deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['bom:read'] }, policy)!
        .allowedOperations,
    ]).toEqual(['easyeda_bom_generate']);
    expect([
      ...deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['easyeda:read'] }, policy)!
        .allowedOperations,
    ]).toHaveLength(2);
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['easyeda:write'] }, policy),
    ).toBeUndefined();
    policy.configuredScopes = 'bom:read';
    expect([...deriveTrustedReadOnlyTaskPrincipal(token, policy)!.allowedOperations]).toEqual([
      'easyeda_bom_generate',
    ]);
    policy.configuredScopes = ' pcb:read ';
    expect([...deriveTrustedReadOnlyTaskPrincipal(token, policy)!.allowedOperations]).toEqual([
      'easyeda_pcb_components',
    ]);
    policy.configuredScopes = '';
    expect(deriveTrustedReadOnlyTaskPrincipal(token, policy)).toBeUndefined();
    policy.configuredScopes = 'unrelated:read';
    expect(deriveTrustedReadOnlyTaskPrincipal(token, policy)).toBeUndefined();
  });

  it('denies all tasks over Remote Relay until existing gateway grant policy is integrated', () => {
    const policy = fixture();
    policy.bridgeBackend = 'remote_relay';
    expect(deriveTrustedReadOnlyTaskPrincipal(token, policy)).toBeUndefined();
  });

  it('refuses disabled profiles and metadata that lose read-only safety', () => {
    const policy = fixture();
    policy.registry.setProfile('core');
    const core = deriveTrustedReadOnlyTaskPrincipal(token, policy);
    expect(core?.allowedOperations.has('easyeda_bom_generate')).toBe(true);
    const tool = policy.registry.get('easyeda_bom_generate')!;
    tool.confirmWrite = true;
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['bom:read'] }, policy),
    ).toBeUndefined();
    tool.confirmWrite = false;
    tool.sideEffect = 'artifact-write';
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['bom:read'] }, policy),
    ).toBeUndefined();
    tool.sideEffect = 'read-only';
    tool.risk = 'high';
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['bom:read'] }, policy),
    ).toBeUndefined();
    tool.risk = 'low';
    tool.annotations.readOnlyHint = false;
    expect(
      deriveTrustedReadOnlyTaskPrincipal({ ...token, scopes: ['bom:read'] }, policy),
    ).toBeUndefined();
  });

  it('validates registered input schemas and blocks injected write/remote/owner controls', () => {
    const policy = fixture();
    const principal = deriveTrustedReadOnlyTaskPrincipal(token, policy)!;
    expect(
      validateReadOnlyTaskArguments(principal, policy, 'easyeda_bom_generate', {
        projectId: 'fixture-project',
        format: 'json',
      }),
    ).toMatchObject({ projectId: 'fixture-project', format: 'json', groupBy: 'value' });
    expect(() =>
      validateReadOnlyTaskArguments(principal, policy, 'easyeda_bom_generate', {
        projectId: 'fixture-project',
        format: 'invalid',
      }),
    ).toThrow();
    for (const key of [
      'ownerId',
      'remoteSessionId',
      'remoteApprovalId',
      'confirmWrite',
      'writeMode',
    ]) {
      expect(() =>
        validateReadOnlyTaskArguments(principal, policy, 'easyeda_bom_generate', {
          projectId: 'fixture-project',
          [key]: 'tamper',
        }),
      ).toThrow('Unsafe task arguments');
    }
    for (const projectId of ['', ' x ', 'x'.repeat(129)]) {
      expect(() =>
        validateReadOnlyTaskArguments(principal, policy, 'easyeda_bom_generate', {
          projectId,
        }),
      ).toThrow('bounded');
    }
  });

  it('rejects unallowlisted operations, privilege revocations and Remote Relay at enqueue', () => {
    const policy = fixture();
    const principal = deriveTrustedReadOnlyTaskPrincipal(
      { ...token, scopes: ['bom:read'] },
      policy,
    )!;
    expect(() =>
      validateReadOnlyTaskArguments(principal, policy, 'easyeda_pcb_components', {
        projectId: 'fixture-project',
      }),
    ).toThrow('not authorized');
    expect(() =>
      validateReadOnlyTaskArguments(
        principal,
        policy,
        'easyeda_pcb_add_track' as 'easyeda_bom_generate',
        {},
      ),
    ).toThrow('not authorized');
    policy.bridgeBackend = 'remote_relay';
    expect(() =>
      validateReadOnlyTaskArguments(principal, policy, 'easyeda_bom_generate', {
        projectId: 'fixture-project',
      }),
    ).toThrow('not authorized');
  });
});
