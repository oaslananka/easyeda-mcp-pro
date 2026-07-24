import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { EnvSchema } from '../src/config/env.js';
import type { ToolProfile } from '../src/config/profiles.js';
import { registerBuiltinTools } from '../src/tools/register.js';
import { ToolRegistry } from '../src/tools/registry.js';

const START = '<!-- capability-counts:start -->';
const END = '<!-- capability-counts:end -->';
const profiles: ToolProfile[] = ['core', 'pro', 'full', 'dev', 'experimental'];
const files = ['README.md', 'docs/security-architecture.md'];
const checkOnly = process.argv.includes('--check');

function countTools(profile: ToolProfile): number {
  const registry = new ToolRegistry();
  registry.setProfile(profile);
  const config = EnvSchema.parse({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  registerBuiltinTools(registry, config);
  return registry.getEnabledTools().length;
}

async function main(): Promise<void> {
  const counts = Object.fromEntries(
    profiles.map((profile) => [profile, countTools(profile)]),
  ) as Record<ToolProfile, number>;

  const generated = [
    START,
    '',
    '| Profile | Registered tools |',
    '| ------- | ---------------: |',
    ...profiles.map((profile) => `| \`${profile}\` | ${counts[profile]} |`),
    '',
    END,
  ].join('\n');

  let stale = false;
  for (const relativePath of files) {
    const filePath = resolve(relativePath);
    const current = readFileSync(filePath, 'utf8');
    const start = current.indexOf(START);
    const end = current.indexOf(END);
    if (start < 0 || end < start) {
      throw new Error(`${relativePath} is missing capability count markers`);
    }
    const replaced = `${current.slice(0, start)}${generated}${current.slice(end + END.length)}`;
    const projectConfig = (await resolveConfig(filePath)) ?? {};
    const next = await format(replaced, { ...projectConfig, parser: 'markdown' });
    if (next !== current) {
      stale = true;
      if (!checkOnly) writeFileSync(filePath, next, 'utf8');
    }
  }

  if (checkOnly && stale) {
    console.error('Capability documentation is stale. Run pnpm generate:capability-docs.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `Capability documentation is current: ${profiles.map((profile) => `${profile}=${counts[profile]}`).join(', ')}`,
  );
}

await main();
