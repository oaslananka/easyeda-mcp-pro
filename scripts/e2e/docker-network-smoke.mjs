#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get } from 'node:http';

const args = process.argv.slice(2);
const imageIndex = args.indexOf('--image');
if (imageIndex < 0 || !args[imageIndex + 1]) {
  console.error('Usage: node scripts/e2e/docker-network-smoke.mjs --image <image>');
  process.exit(2);
}

const image = args[imageIndex + 1];
const prefix = `easyeda-mcp-network-${process.pid}`;
const containers = new Set();
const dockerCandidates = ['/usr/bin/docker', '/usr/local/bin/docker'];
const dockerBinary = dockerCandidates.find((candidate) => existsSync(candidate));
if (!dockerBinary) {
  throw new Error(
    `Docker executable not found in supported locations: ${dockerCandidates.join(', ')}`,
  );
}

function docker(commandArgs, options = {}) {
  const result = spawnSync(dockerBinary, commandArgs, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  });
  if (options.expectSuccess !== false && result.status !== 0) {
    throw new Error(
      `docker ${commandArgs.join(' ')} failed (${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function removeContainer(name) {
  docker(['rm', '-f', name], { expectSuccess: false, timeout: 30_000 });
  containers.delete(name);
}

function startContainer(name, extraArgs = []) {
  removeContainer(name);
  const result = docker(['run', '-d', '--name', name, ...extraArgs, image]);
  containers.add(name);
  return result.stdout.trim();
}

async function waitForInternalHealth(name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastOutput = '';
  while (Date.now() < deadline) {
    const result = docker(
      [
        'exec',
        name,
        'node',
        '-e',
        "const r=await fetch('http://127.0.0.1:3000/healthz');if(!r.ok)process.exit(1);const p=await r.json();if(p.status!=='ok')process.exit(1);console.log(JSON.stringify(p));",
      ],
      { expectSuccess: false, timeout: 10_000 },
    );
    lastOutput = `${result.stdout}${result.stderr}`;
    if (result.status === 0) return result.stdout.trim();
    const state = docker(['inspect', '-f', '{{.State.Running}}', name], {
      expectSuccess: false,
      timeout: 10_000,
    });
    if (state.status === 0 && state.stdout.trim() !== 'true') {
      const logs = docker(['logs', name], { expectSuccess: false, timeout: 10_000 });
      throw new Error(`container stopped before health was ready:
${logs.stdout}${logs.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const logs = docker(['logs', name], { expectSuccess: false, timeout: 10_000 });
  throw new Error(
    `internal health check did not pass: ${lastOutput}
${logs.stdout}${logs.stderr}`,
  );
}

function requestEndpoint(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, { timeout: 2_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          authenticate: response.headers['www-authenticate'] ?? '',
          body,
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
  });
}

async function waitForPublishedEndpoint(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await requestEndpoint(url);
      if (result.statusCode === 401 && String(result.authenticate).includes('Bearer')) {
        return result;
      }
      lastError = new Error(
        `expected OAuth challenge, received HTTP ${String(result.statusCode)}: ${result.body}`,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`published endpoint was not reachable at ${url}: ${String(lastError)}`);
}

function publishedPort(name) {
  const result = docker(['port', name, '3000/tcp']);
  const match = result.stdout.trim().match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)$/);
  if (!match) throw new Error(`could not resolve published port: ${result.stdout}`);
  return Number(match[1]);
}

async function run() {
  const doctor = docker([
    'run',
    '--rm',
    '-e',
    'BRIDGE_PORT_SCAN=1',
    '--entrypoint',
    'node',
    image,
    'dist/index.js',
    '--doctor',
  ]);
  const doctorOutput = `${doctor.stdout}${doctor.stderr}`;
  for (const expected of [
    'Runtime mode: production-runtime',
    'pnpm: NOT REQUIRED (production-runtime)',
    'MCP server entry: OK',
    'EasyEDA extension package: OK',
  ]) {
    if (!doctorOutput.includes(expected)) {
      throw new Error(`hardened runtime doctor did not report ${expected}:
${doctorOutput}`);
    }
  }
  console.log('hardened runtime doctor: package managers not required; artifacts verified');

  const defaultName = `${prefix}-default`;
  startContainer(defaultName);
  const internal = await waitForInternalHealth(defaultName);
  console.log(`default loopback smoke: ${internal}`);
  removeContainer(defaultName);

  const unsafeName = `${prefix}-unsafe`;
  const unsafe = docker(['run', '--name', unsafeName, '-e', 'HTTP_HOST=0.0.0.0', image], {
    expectSuccess: false,
  });
  containers.add(unsafeName);
  const unsafeOutput = `${unsafe.stdout}${unsafe.stderr}`;
  if (unsafe.status === 0 || !unsafeOutput.includes('SAFETY:')) {
    throw new Error(`unsafe non-loopback startup did not fail closed:\n${unsafeOutput}`);
  }
  console.log('unsafe non-loopback startup: rejected as expected');
  removeContainer(unsafeName);

  const publishedName = `${prefix}-published`;
  startContainer(publishedName, [
    '-p',
    '127.0.0.1::3000',
    '-e',
    'HTTP_HOST=0.0.0.0',
    '-e',
    'ALLOWED_ORIGINS=https://client.example.com',
    '-e',
    'OAUTH_ENABLED=true',
    '-e',
    'OAUTH_ISSUER=https://auth.example.com',
    '-e',
    'OAUTH_AUDIENCE=https://mcp.example.com/mcp',
    '-e',
    'OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json',
  ]);
  const port = publishedPort(publishedName);
  const challenge = await waitForPublishedEndpoint(`http://127.0.0.1:${port}/healthz`);
  console.log(
    `published host-port smoke: HTTP ${String(challenge.statusCode)} with OAuth challenge`,
  );
}

try {
  await run();
} finally {
  for (const name of containers) removeContainer(name);
}
