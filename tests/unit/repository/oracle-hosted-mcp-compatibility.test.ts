import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(
  new URL('../../../deploy/oracle-free/compose.yaml', import.meta.url),
  'utf8',
);

describe('Oracle Hosted Cloud cross-client MCP deployment contract', () => {
  it('permits the official EasyEDA Pro browser relay without allowing arbitrary origins', () => {
    expect(compose).toContain(
      'ALLOWED_ORIGINS: ${EASYEDA_PUBLIC_ORIGIN:?Set canonical HTTPS domain},https://pro.easyeda.com',
    );
    expect(compose).not.toMatch(/ALLOWED_ORIGINS:\s*\*/);
  });

  it('serves both MCP eras and a read-only MCP Apps UI without loosening authorization', () => {
    expect(compose).toContain("MCP_V2_EXPERIMENTAL: 'true'");
    expect(compose).toContain("MCP_APPS_ENABLED: 'true'");
    expect(compose).toContain("OAUTH_ENABLED: 'true'");
    expect(compose).toContain("HTTP_AUTH_DISABLED: 'false'");
    expect(compose).toContain('OAUTH_REQUIRED_SCOPES: easyeda.read');
    expect(compose).toContain("'127.0.0.1:");
    expect(compose).toContain('image:');
    expect(compose).not.toMatch(/ALLOWED_ORIGINS:\s*\*/);
  });
});
