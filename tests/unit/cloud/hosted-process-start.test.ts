import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No loopback port');
  return await new Promise<number>((resolve) => server.close(() => resolve(addr.port)));
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  // On Windows a signalled child can have exitCode === null even after exit.
  // Never subscribe indefinitely to a close event that may already have fired.
  const stopped = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (stopped()) return;

  const waitForClose = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (stopped()) return resolve(true);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('close', onClose);
        resolve(stopped());
      }, timeoutMs);
      child.once('close', onClose);
    });

  child.kill('SIGTERM');
  if (await waitForClose(4_000)) return;
  child.kill('SIGKILL');
  if (!(await waitForClose(4_000))) {
    throw new Error('Hosted Cloud test subprocess did not terminate');
  }
}

describe('Hosted Cloud executable startup (no external social providers)', () => {
  it(
    'starts the real entrypoint with opt-in OAuth, publishes discovery and creates provider tables',
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'easyeda-hosted-849-'));
      const port = await availablePort();
      const origin = `http://127.0.0.1:${port}`;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        TRANSPORT: 'http',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: String(port),
        MCP_BRIDGE_BACKEND: 'remote_relay',
        OAUTH_ENABLED: 'true',
        OAUTH_ISSUER: `${origin}/api/auth`,
        OAUTH_AUDIENCE: `${origin}/mcp`,
        OAUTH_JWKS_URI: `${origin}/api/auth/jwks`,
        OAUTH_REQUIRED_SCOPES: 'easyeda.read',
        CLOUD_HOSTED_ENABLED: 'true',
        CLOUD_HOSTED_ORIGIN: origin,
        CLOUD_AUTH_SECRET: 'local-only-smoke-test-signing-secret-123456',
        CLOUD_GITHUB_CLIENT_ID: 'fake-github-client',
        CLOUD_GITHUB_CLIENT_SECRET: 'fake-github-secret',
        CLOUD_GOOGLE_CLIENT_ID: 'fake-google-client',
        CLOUD_GOOGLE_CLIENT_SECRET: 'fake-google-secret',
        DATA_DIR: dataDir,
      };
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-1500);
      });

      try {
        let response: Response | undefined;
        for (let attempt = 0; attempt < 70; attempt++) {
          if (child.exitCode !== null) throw new Error(`Cloud exited early: ${stderr}`);
          try {
            response = await fetch(`${origin}/api/auth/.well-known/oauth-authorization-server`);
            break;
          } catch {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
        expect(response?.status, stderr).toBe(200);
        await expect(response!.json()).resolves.toMatchObject({
          issuer: `${origin}/api/auth`,
          token_endpoint: `${origin}/api/auth/oauth2/token`,
        });
        const resource = await fetch(`${origin}/.well-known/oauth-protected-resource`);
        expect(resource.status).toBe(200);
        await expect(resource.json()).resolves.toMatchObject({ resource: `${origin}/mcp` });
        const jwks = await fetch(`${origin}/api/auth/jwks`);
        expect(jwks.status).toBe(200);
        await expect(jwks.json()).resolves.toHaveProperty('keys');
        expect((await stat(join(dataDir, 'hosted-cloud.sqlite'))).size).toBeGreaterThan(0);
        const signIn = await fetch(`${origin}/sign-in`);
        expect(signIn.status).toBe(200);
        expect(await signIn.text()).toContain('Continue with GitHub');
        const portal = await fetch(`${origin}/cloud`, { redirect: 'manual' });
        expect(portal.status).toBe(303);
        expect(portal.headers.get('location')).toBe('/sign-in');
        const fakeClient = await fetch(`${origin}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'github', callbackURL: '/cloud' }),
        });
        expect(fakeClient.status).toBe(200);
        const fakeProviderURL = (await fakeClient.json()) as { url?: string };
        expect(fakeProviderURL.url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
      } finally {
        try {
          await stopChild(child);
        } finally {
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    process.platform === 'win32' ? 45_000 : 20_000,
  );
});
