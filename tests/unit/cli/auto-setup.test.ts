import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  runSetup,
  runExtension,
  formatClientList,
  runInteractiveInit,
} from '../../../src/cli/auto-setup.js';
import * as fs from 'node:fs';

const mockQuestion = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: mockQuestion,
    close: vi.fn(),
  }),
}));

describe('auto-setup CLI module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats the client list correctly', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const list = formatClientList();
    expect(list).toContain('easyeda-mcp-pro — supported MCP clients');
    expect(list).toContain('claude');
    expect(list).toContain('cursor');
  });

  it('runs setup for an unknown client', () => {
    const result = runSetup({ client: 'unknown-client' as any });
    expect(result).toContain('Unknown client: unknown-client');
  });

  it('runs setup for list mode', () => {
    const result = runSetup({ client: 'list' });
    expect(result).toContain('easyeda-mcp-pro — supported MCP clients');
  });

  it('runs setup for a specific client (e.g. cursor)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ mcpServers: {} }));

    const result = runSetup({ client: 'cursor', profile: 'pro' });
    expect(result).toContain('Updated Cursor IDE config');
    expect(result).not.toContain('Stale entry detected');
    expect(result).not.toContain('already up to date');
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('detects and replaces a stale existing server entry', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'easyeda-mcp-pro': { command: 'node', args: ['/old/path/dist/index.js'] },
        },
      }),
    );

    const result = runSetup({ client: 'cursor', profile: 'pro' });
    expect(result).toContain('Stale entry detected and replaced');
    expect(result).toContain('command:');
    expect(result).toContain('args:');
  });

  it('reports an existing entry as already up to date when it matches exactly', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'easyeda-mcp-pro': { command: 'npx', args: ['-y', 'easyeda-mcp-pro@latest'] },
        },
      }),
    );

    const result = runSetup({ client: 'cursor', profile: 'core' });
    expect(result).toContain('Existing entry was already up to date.');
    expect(result).not.toContain('Stale entry detected');
  });

  it('runs extension command and detects path', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = runExtension({});
    expect(result).toContain('Extension package found');
  });

  it('copies extension if copy flag is provided', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('dummy-data');

    const result = runExtension({ copy: '/some/dest' });
    expect(result).toContain('Copied to');
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('runs interactive init setup wizard successfully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ mcpServers: {} }));

    mockQuestion
      .mockResolvedValueOnce('2') // Cursor IDE
      .mockResolvedValueOnce('3') // full profile
      .mockResolvedValueOnce('3'); // Skip extension setup

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInteractiveInit();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('easyeda-mcp-pro Setup Wizard'),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Setup wizard complete'));
    expect(fs.writeFileSync).toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });
});
