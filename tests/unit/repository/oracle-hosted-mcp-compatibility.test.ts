import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(
  new URL('../../../deploy/oracle-free/compose.yaml', import.meta.url),
  'utf8',
);

describe('Oracle Hosted Cloud cross-client MCP deployment contract', () => {
  it('permits the official EasyEDA Pro browser relay without allowing arbitrary origins', () => {
    expect(compose).toContain(
      'ALLOWED_ORIGINS: ${EASYEDA_PUBLIC_ORIGIN:?Set canonical HTTPS domain},https://pro.easyeda.com,http://127.0.0.1:6274,http://localhost:6274,https://app.mcpjam.com',
    );
    expect(compose).not.toMatch(/ALLOWED_ORIGINS:\s*\*/);
  });

  it('bounds the WebSocket frame for real Gerber exports without disabling binary safety', () => {
    expect(compose).toContain(
      "BRIDGE_MAX_PAYLOAD_SIZE: '${EASYEDA_BRIDGE_MAX_PAYLOAD_SIZE:-8388608}'",
    );
    // This stays within the schema's 10 MiB hard cap and the in-memory
    // frame budget; do not make the owner pilot unlimited.
    expect(8_388_608).toBeLessThanOrEqual(10_485_760);
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

describe('optional Hosted ingress', () => {
  it('passes the exact peer setting without enabling it by default', () => {
    const compose = readFileSync(
      new URL('../../../deploy/oracle-free/compose.yaml', import.meta.url),
      'utf8',
    );
    const example = readFileSync(
      new URL('../../../deploy/oracle-free/.env.example', import.meta.url),
      'utf8',
    );
    expect(compose).toContain("CLOUD_TRUSTED_PROXY_IP: '${CLOUD_TRUSTED_PROXY_IP:-}'");
    expect(example).toMatch(/^CLOUD_TRUSTED_PROXY_IP=$/m);
  });
});
