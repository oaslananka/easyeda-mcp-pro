import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

// ── Types ───────────────────────────────────────────────────

export type ClientName =
  'claude' | 'cursor' | 'vscode' | 'windsurf' | 'cline' | 'gemini' | 'zed' | 'amazonq' | 'continue';

export type SetupAction = 'setup' | 'extension';

export interface SetupOptions {
  client?: ClientName | 'all' | 'list';
  profile?: string;
  open?: boolean;
  copy?: string;
}

export interface ClientDefinition {
  name: ClientName;
  displayName: string;
  configPaths: ConfigPath[];
  serverKey: string;
  wrapKey?: string;
}

export interface ConfigPath {
  platform: 'win32' | 'darwin' | 'linux' | 'all';
  path: string;
}

// ── Constants ───────────────────────────────────────────────

export const SERVER_NAME = 'easyeda-mcp-pro';
export const NPX_COMMAND = 'npx';
export const NPX_ARGS = ['-y', `${SERVER_NAME}@latest`];

// ── Package / extension helpers ─────────────────────────────

export function resolvePackageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export function getExtensionPath(): string {
  return join(resolvePackageRoot(), 'easyeda-bridge-extension.eext');
}

// ── Path helpers ────────────────────────────────────────────

export function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

export function appData(): string {
  return process.env.APPDATA ?? join(home(), 'AppData', 'Roaming');
}

// ── Client definitions ──────────────────────────────────────

export const CLIENTS: ClientDefinition[] = [
  {
    name: 'claude',
    displayName: 'Claude Desktop',
    serverKey: 'mcpServers',
    configPaths: [
      { platform: 'win32', path: join(appData(), 'Claude', 'claude_desktop_config.json') },
      {
        platform: 'darwin',
        path: join(
          home(),
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        ),
      },
      { platform: 'linux', path: join(home(), '.config', 'Claude', 'claude_desktop_config.json') },
    ],
  },
  {
    name: 'cursor',
    displayName: 'Cursor IDE',
    serverKey: 'mcpServers',
    configPaths: [{ platform: 'all', path: join(home(), '.cursor', 'mcp.json') }],
  },
  {
    name: 'vscode',
    displayName: 'VS Code (Copilot)',
    serverKey: 'servers',
    configPaths: [
      { platform: 'win32', path: join(appData(), 'Code', 'User', 'mcp.json') },
      {
        platform: 'darwin',
        path: join(home(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      },
      { platform: 'linux', path: join(home(), '.config', 'Code', 'User', 'mcp.json') },
    ],
  },
  {
    name: 'windsurf',
    displayName: 'Windsurf (Codeium)',
    serverKey: 'mcpServers',
    configPaths: [
      { platform: 'all', path: join(home(), '.codeium', 'windsurf', 'mcp_config.json') },
    ],
  },
  {
    name: 'cline',
    displayName: 'Cline',
    serverKey: 'mcpServers',
    configPaths: [
      {
        platform: 'win32',
        path: join(
          appData(),
          'Code',
          'User',
          'globalStorage',
          'saoudrizwan.claude-dev',
          'settings',
          'cline_mcp_settings.json',
        ),
      },
      {
        platform: 'darwin',
        path: join(
          home(),
          'Library',
          'Application Support',
          'Code',
          'User',
          'globalStorage',
          'saoudrizwan.claude-dev',
          'settings',
          'cline_mcp_settings.json',
        ),
      },
      {
        platform: 'linux',
        path: join(
          home(),
          '.config',
          'Code',
          'User',
          'globalStorage',
          'saoudrizwan.claude-dev',
          'settings',
          'cline_mcp_settings.json',
        ),
      },
    ],
  },
  {
    name: 'gemini',
    displayName: 'Gemini CLI / Antigravity',
    serverKey: 'mcpServers',
    configPaths: [{ platform: 'all', path: join(home(), '.gemini', 'settings.json') }],
  },
  {
    name: 'zed',
    displayName: 'Zed Editor',
    serverKey: 'context_servers',
    configPaths: [
      { platform: 'darwin', path: join(home(), '.config', 'zed', 'settings.json') },
      { platform: 'linux', path: join(home(), '.config', 'zed', 'settings.json') },
      { platform: 'win32', path: join(appData(), 'Zed', 'settings.json') },
    ],
  },
  {
    name: 'amazonq',
    displayName: 'Amazon Q Developer',
    serverKey: 'mcpServers',
    configPaths: [{ platform: 'all', path: join(home(), '.aws', 'amazonq', 'mcp.json') }],
  },
  {
    name: 'continue',
    displayName: 'Continue.dev',
    serverKey: 'mcpServers',
    configPaths: [{ platform: 'all', path: join(home(), '.continue', 'config.json') }],
  },
];

// ── Detection ───────────────────────────────────────────────

export function findConfigPath(client: ClientDefinition): string | null {
  const platform = process.platform;

  // First try to find an existing config file
  for (const cp of client.configPaths) {
    if (cp.platform === 'all' || cp.platform === platform) {
      if (existsSync(cp.path)) return cp.path;
    }
  }

  // If none exists, return the first matching platform path
  for (const cp of client.configPaths) {
    if (cp.platform === 'all' || cp.platform === platform) {
      return cp.path;
    }
  }

  return null;
}

export function detectInstalledClients(): ClientDefinition[] {
  return CLIENTS.filter((client) => {
    const configPath = findConfigPath(client);
    if (!configPath) return false;

    // Check if config file exists
    if (existsSync(configPath)) return true;

    // Check if parent directory exists (client is likely installed)
    const parentDir = dirname(configPath);
    return existsSync(parentDir);
  });
}

export function configHasServer(configPath: string, serverKey: string): boolean {
  try {
    const data = readJsonFile(configPath);
    const servers = data[serverKey] as Record<string, unknown> | undefined;
    return servers !== undefined && SERVER_NAME in servers;
  } catch {
    return false;
  }
}

// ── Platform helpers ────────────────────────────────────────

export function openFileLocation(filePath: string): void {
  const dir = dirname(filePath);
  try {
    switch (process.platform) {
      case 'win32': {
        const windowsRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
        execFile(join(windowsRoot, 'explorer.exe'), [
          '/select,' + filePath.replaceAll('/', win32.sep),
        ]);
        break;
      }
      case 'darwin':
        execFile('/usr/bin/open', ['-R', filePath]);
        break;
      default:
        execFile('/usr/bin/xdg-open', [dir]);
        break;
    }
  } catch {
    // Silently ignore — the path is already printed
  }
}

// ── Status helpers ───────────────────────────────────────────

export function ok(text: string): string {
  return `  ✅ ${text}`;
}
export function info(text: string): string {
  return `  ℹ️  ${text}`;
}
export function warn(text: string): string {
  return `  ⚠️  ${text}`;
}

// ── Shared JSON helper (also used by configHasServer) ───────

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
