import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import {
  CLIENTS,
  SERVER_NAME,
  configHasServer,
  detectInstalledClients,
  findConfigPath,
  getExtensionPath,
  ok,
  info,
  warn,
  openFileLocation,
} from '../../../src/cli/client-definitions.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('client definitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('{}');
  });

  it('returns the first matching config path when no config exists yet', () => {
    const cursor = CLIENTS.find((client) => client.name === 'cursor');

    expect(cursor).toBeDefined();
    expect(findConfigPath(cursor!)).toContain('.cursor');
  });

  it('prefers an existing config path', () => {
    const cursor = CLIENTS.find((client) => client.name === 'cursor');
    vi.mocked(fs.existsSync).mockImplementation((path) => String(path).endsWith('mcp.json'));

    expect(findConfigPath(cursor!)).toContain('mcp.json');
  });

  it('detects installed clients from existing config or parent directories', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      const value = String(path);
      return value.includes('.cursor') || value.includes('.continue');
    });

    const installed = detectInstalledClients().map((client) => client.name);

    expect(installed).toContain('cursor');
    expect(installed).toContain('continue');
  });

  it('detects whether a config already contains the server', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: 'npx' } } }),
    );

    expect(configHasServer('/tmp/mcp.json', 'mcpServers')).toBe(true);
  });

  it('returns false for invalid or missing config JSON', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('missing');
    });

    expect(configHasServer('/tmp/missing.json', 'mcpServers')).toBe(false);
  });

  it('builds the packaged extension path', () => {
    expect(getExtensionPath()).toContain('easyeda-bridge-extension.eext');
  });

  it('formats status lines', () => {
    expect(ok('ready')).toContain('ready');
    expect(info('next')).toContain('next');
    expect(warn('careful')).toContain('careful');
  });

  it('opens file locations with a platform-specific command', () => {
    openFileLocation('/tmp/example/mcp.json');

    expect(execFile).toHaveBeenCalled();
  });
});
