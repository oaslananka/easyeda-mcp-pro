import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { EnvSchema } from '../../../../src/config/env.js';
import { createHttpTransport } from '../../../../src/server/transports/http.js';

function createTestConfig(port: number) {
  return EnvSchema.parse({
    NODE_ENV: 'test',
    TRANSPORT: 'http',
    HTTP_PORT: port,
    OAUTH_ENABLED: true,
    OAUTH_ISSUER: 'https://auth.example.com',
    OAUTH_AUDIENCE: `http://127.0.0.1:${port}/mcp`,
    OAUTH_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
  });
}

async function withServer<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const httpTransport = createHttpTransport(createTestConfig(port));
  const server = http.createServer(httpTransport.app);
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );

  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('HTTP OAuth protected resource metadata', () => {
  it('serves protected resource metadata for the MCP resource', async () => {
    await withServer(3921, async () => {
      const res = await fetch(
        'http://127.0.0.1:3921/.well-known/oauth-protected-resource/mcp',
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
        bearer_methods_supported: string[];
      };

      expect(body.resource).toBe('http://127.0.0.1:3921/mcp');
      expect(body.authorization_servers).toEqual(['https://auth.example.com']);
      expect(body.scopes_supported).toContain('easyeda.read');
      expect(body.scopes_supported).toContain('easyeda.project_admin');
      expect(body.bearer_methods_supported).toEqual(['header']);
    });
  });

  it('adds a metadata discovery challenge to 401 responses', async () => {
    await withServer(3922, async () => {
      const res = await fetch('http://127.0.0.1:3922/mcp');
      const challenge = res.headers.get('www-authenticate');

      expect(res.status).toBe(401);
      expect(challenge).toContain(
        'resource_metadata="http://127.0.0.1:3922/.well-known/oauth-protected-resource/mcp"',
      );
      expect(challenge).toContain('error="missing_auth"');
    });
  });
});
