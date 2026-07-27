import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  loadMcpPublisherPolicy,
  resolveMcpPublisherAsset,
  verifyAndInstallMcpPublisher,
} from './mcp-publisher-integrity.mjs';

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new TypeError(`invalid argument sequence near ${String(flag)}`);
    }
    values[flag.slice(2)] = value;
  }
  return { command, values };
}

function requireArgument(values, name) {
  const value = values[name];
  if (!value) throw new TypeError(`missing required --${name}`);
  return value;
}

const { command, values } = parseArguments(process.argv.slice(2));
const policyPath = resolve(values.policy ?? 'config/mcp-publisher-integrity.json');
const os = requireArgument(values, 'os');
const arch = requireArgument(values, 'arch');
const policy = await loadMcpPublisherPolicy({ policyPath });

if (command === 'resolve') {
  const resolved = resolveMcpPublisherAsset(policy, { os, arch });
  const githubEnv = requireArgument(values, 'github-env');
  await appendFile(
    githubEnv,
    [
      `MCP_PUBLISHER_VERSION=${resolved.version}`,
      `MCP_PUBLISHER_ASSET=${resolved.asset}`,
      `MCP_PUBLISHER_ARCHIVE_URL=${resolved.archiveUrl}`,
      `MCP_PUBLISHER_CHECKSUMS_ASSET=${resolved.checksumsAsset}`,
      `MCP_PUBLISHER_CHECKSUMS_URL=${resolved.checksumsUrl}`,
      '',
    ].join('\n'),
    'utf8',
  );
  console.log(`Resolved ${resolved.key}: ${resolved.asset}`);
} else if (command === 'install') {
  const installed = await verifyAndInstallMcpPublisher({
    policy,
    os,
    arch,
    archivePath: resolve(requireArgument(values, 'archive')),
    checksumsPath: resolve(requireArgument(values, 'checksums')),
    destination: resolve(requireArgument(values, 'destination')),
  });
  console.log(`Installed verified mcp-publisher: ${installed}`);
} else {
  throw new TypeError('command must be resolve or install');
}
