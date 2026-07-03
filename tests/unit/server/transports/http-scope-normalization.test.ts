import { describe, expect, it } from 'vitest';
import { normalizeOAuthScope } from '../../../../src/server/transports/http.js';

describe('normalizeOAuthScope', () => {
  it('normalizes legacy colon scopes to remote dot scopes', () => {
    expect(normalizeOAuthScope('easyeda:read')).toBe('easyeda.read');
    expect(normalizeOAuthScope('easyeda:write')).toBe('easyeda.write');
    expect(normalizeOAuthScope('easyeda:export')).toBe('easyeda.export');
  });

  it('normalizes project admin spelling while preserving dot scopes', () => {
    expect(normalizeOAuthScope('easyeda:project-admin')).toBe('easyeda.project_admin');
    expect(normalizeOAuthScope('easyeda.project_admin')).toBe('easyeda.project_admin');
  });
});
