import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema, getEnvironmentVariableNames, type EnvConfig } from '../../../src/config/env.js';
import {
  applyRegistryEnvironmentVariables,
  buildRegistryEnvironmentVariables,
  loadEnvironmentMetadata,
  serializeServerJson,
  validateEnvironmentMetadata,
} from '../../../scripts/environment-metadata.mts';

const root = path.resolve(import.meta.dirname, '../../..');
const metadata = loadEnvironmentMetadata(root);
const runtimeDefaults = EnvSchema.parse({});
const runtimeNames = getEnvironmentVariableNames();

function readServerJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('MCP Registry environment metadata', () => {
  it('classifies every runtime variable as public or explicitly excluded', () => {
    const publicNames = metadata.variables.map((variable) => variable.name);
    const excludedNames = metadata.excludedVariables.map((variable) => variable.name);

    expect(new Set(publicNames).size).toBe(publicNames.length);
    expect(new Set(excludedNames).size).toBe(excludedNames.length);
    expect(publicNames.filter((name) => excludedNames.includes(name))).toEqual([]);
    expect([...publicNames, ...excludedNames].sort()).toEqual([...runtimeNames].sort());
    expect(excludedNames.sort()).toEqual([
      'BRIDGE_HOT_SWAP_CHUNK_BYTES',
      'BRIDGE_HOT_SWAP_ENABLED',
      'BRIDGE_HOT_SWAP_WATCH',
    ]);
  });

  it('validates descriptions, defaults, formats, exclusions, and secret classification', () => {
    expect(validateEnvironmentMetadata({ metadata, runtimeDefaults, runtimeNames })).toEqual([]);

    const generated = buildRegistryEnvironmentVariables(metadata, runtimeDefaults);
    const byName = new Map(generated.map((variable) => [variable.name, variable]));

    for (const requiredName of [
      'TOOL_SCOPES',
      'KEYLESS_SOURCING_ENABLED',
      'SOURCING_CACHE_TTL_SECONDS',
      'VENDOR_MIN_REQUEST_INTERVAL_MS',
    ]) {
      expect(byName.has(requiredName), requiredName).toBe(true);
    }

    expect(byName.get('KEYLESS_SOURCING_ENABLED')).toMatchObject({
      format: 'boolean',
      default: 'true',
    });
    expect(byName.get('SOURCING_CACHE_TTL_SECONDS')).toMatchObject({
      format: 'number',
      default: '21600',
    });
    expect(byName.get('VENDOR_MIN_REQUEST_INTERVAL_MS')).toMatchObject({
      format: 'number',
      default: '150',
    });

    for (const dynamicName of ['DATA_DIR', 'SQLITE_PATH', 'ARTIFACT_DIR', 'CACHE_DIR']) {
      const variable = byName.get(dynamicName);
      expect(variable?.format, dynamicName).toBe('filepath');
      expect(variable, dynamicName).not.toHaveProperty('default');
      expect(variable?.placeholder, dynamicName).toBeTruthy();
    }

    const secretNames = generated
      .filter((variable) => variable.isSecret)
      .map((variable) => variable.name)
      .sort();
    expect(secretNames).toEqual([
      'AI_API_KEY',
      'BRIDGE_TOKEN',
      'DIGIKEY_CLIENT_SECRET',
      'JLCPCB_CLIENT_SECRET',
      'LCSC_API_KEY',
      'LCSC_API_SECRET',
      'MOUSER_API_KEY',
    ]);
    expect(byName.get('DIGIKEY_CLIENT_ID')).not.toHaveProperty('isSecret');
    expect(byName.get('JLCPCB_CLIENT_ID')).not.toHaveProperty('isSecret');
  });

  it('keeps server.json equal to the deterministic generated inventory', () => {
    const generated = buildRegistryEnvironmentVariables(metadata, runtimeDefaults);
    const serverJson = readServerJson();
    const packages = serverJson.packages as Array<Record<string, unknown>>;

    expect(packages[0]?.environmentVariables).toEqual(generated);

    const once = applyRegistryEnvironmentVariables(serverJson, generated);
    const twice = applyRegistryEnvironmentVariables(once, generated);
    expect(serializeServerJson(twice)).toBe(serializeServerJson(once));
  });

  it('wires the deterministic parity check into repository metadata verification', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['generate:environment-metadata']).toBe(
      'tsx scripts/generate-server-environment.mts',
    );
    expect(packageJson.scripts?.['check:environment-metadata']).toBe(
      'tsx scripts/generate-server-environment.mts --check',
    );
    expect(packageJson.scripts?.['check:metadata']).toContain('pnpm check:environment-metadata');
  });

  it('keeps public examples aligned with active runtime terminology', () => {
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const configurationGuide = fs.readFileSync(
      path.join(root, 'docs/guide/configuration.md'),
      'utf8',
    );

    expect(envExample).toContain('OAUTH_REQUIRED_SCOPES=easyeda:read');
    for (const variable of metadata.variables) {
      expect(envExample, variable.name).toMatch(new RegExp(`^#? ?${variable.name}=`, 'm'));
    }
    for (const name of [
      'KEYLESS_SOURCING_ENABLED',
      'SOURCING_CACHE_TTL_SECONDS',
      'VENDOR_MIN_REQUEST_INTERVAL_MS',
    ]) {
      expect(readme, name).toContain(`\`${name}\``);
      expect(configurationGuide, name).toContain(`\`${name}\``);
    }
  });
});
