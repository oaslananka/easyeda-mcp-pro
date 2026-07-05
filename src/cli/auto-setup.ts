import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getLogger } from '../utils/logger.js';
import {
  type ClientDefinition,
  type ClientName,
  type SetupOptions,
  SERVER_NAME,
  NPX_COMMAND,
  NPX_ARGS,
  CLIENTS,
  findConfigPath,
  detectInstalledClients,
  getExtensionPath,
  configHasServer,
  openFileLocation,
  ok,
  info,
  warn,
} from './client-definitions.js';

// ── Safe logger fallback for CLI paths where pino may not be initialized yet ──

function logError(message: string, err?: unknown): void {
  try {
    getLogger().error(err, message);
  } catch {
    console.error(message, err);
  }
}

// ── Server entry builder ────────────────────────────────────

function buildServerEntry(profile: string, client: ClientDefinition): Record<string, unknown> {
  const base: Record<string, unknown> = {
    command: NPX_COMMAND,
    args: [...NPX_ARGS],
  };

  if (profile !== 'core') {
    base.env = { TOOL_PROFILE: profile };
  }

  // Cline has extra fields
  if (client.name === 'cline') {
    base.disabled = false;
    base.autoApprove = [];
  }

  // Zed uses different structure
  if (client.name === 'zed') {
    return {
      command: {
        path: NPX_COMMAND,
        args: [...NPX_ARGS],
        env: profile !== 'core' ? { TOOL_PROFILE: profile } : undefined,
      },
      settings: {},
    };
  }

  return base;
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function mergeServerEntry(
  existing: Record<string, unknown>,
  serverKey: string,
  serverEntry: Record<string, unknown>,
): Record<string, unknown> {
  const servers = (existing[serverKey] as Record<string, unknown>) ?? {};
  servers[SERVER_NAME] = serverEntry;
  return { ...existing, [serverKey]: servers };
}

/** Read the existing server entry for this project under `serverKey`, if any. */
function readExistingEntry(
  existing: Record<string, unknown>,
  serverKey: string,
): Record<string, unknown> | undefined {
  const servers = existing[serverKey] as Record<string, unknown> | undefined;
  const entry = servers?.[SERVER_NAME];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
}

function describeStaleConfig(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const notes: string[] = [];
  const prevCommand = JSON.stringify(previous.command);
  const nextCommand = JSON.stringify(next.command);
  if (prevCommand !== nextCommand) {
    notes.push(`command: ${prevCommand} -> ${nextCommand}`);
  }
  const prevArgs = JSON.stringify(previous.args ?? []);
  const nextArgs = JSON.stringify(next.args ?? []);
  if (prevArgs !== nextArgs) {
    notes.push(`args: ${prevArgs} -> ${nextArgs}`);
  }
  const prevEnv = JSON.stringify(previous.env ?? {});
  const nextEnv = JSON.stringify(next.env ?? {});
  if (prevEnv !== nextEnv) {
    notes.push(`env: ${prevEnv} -> ${nextEnv}`);
  }
  return notes;
}

// ── Core: setup a single client ─────────────────────────────

function setupClient(client: ClientDefinition, profile: string): string[] {
  const lines: string[] = [];
  const configPath = findConfigPath(client);

  if (!configPath) {
    lines.push(warn(`No config path found for ${client.displayName} on ${process.platform}`));
    return lines;
  }

  const serverEntry = buildServerEntry(profile, client);
  const fileExists = existsSync(configPath);
  const existing = fileExists ? readJsonFile(configPath) : {};
  const previousEntry = readExistingEntry(existing, client.serverKey);
  const merged = mergeServerEntry(existing, client.serverKey, serverEntry);

  writeJsonFile(configPath, merged);

  if (fileExists) {
    lines.push(ok(`Updated ${client.displayName} config`));
  } else {
    lines.push(ok(`Created ${client.displayName} config`));
  }

  if (previousEntry) {
    const staleNotes = describeStaleConfig(previousEntry, serverEntry);
    if (staleNotes.length > 0) {
      lines.push(warn(`Stale entry detected and replaced:`));
      for (const note of staleNotes) {
        lines.push(info(`  ${note}`));
      }
    } else {
      lines.push(info('Existing entry was already up to date.'));
    }
  }

  lines.push(info(`Path: ${configPath}`));

  return lines;
}

// ── Public: run setup command ───────────────────────────────

export function runSetup(options: SetupOptions): string {
  const profile = options.profile ?? 'core';
  const clientName = options.client ?? 'list';

  if (clientName === 'list') {
    return formatClientList();
  }

  const lines: string[] = [`easyeda-mcp-pro setup (profile: ${profile})`, ''];

  if (clientName === 'all') {
    const detected = detectInstalledClients();
    if (detected.length === 0) {
      lines.push(warn('No MCP clients detected on this system.'));
      lines.push('');
      lines.push('Supported clients:');
      for (const c of CLIENTS) {
        lines.push(`  • ${c.displayName} (${c.name})`);
      }
      return lines.join('\n');
    }

    lines.push(`Detected ${detected.length} client(s):`);
    lines.push('');

    for (const client of detected) {
      lines.push(`── ${client.displayName} ──`);
      lines.push(...setupClient(client, profile));
      lines.push('');
    }
  } else {
    const client = CLIENTS.find((c) => c.name === clientName);
    if (!client) {
      lines.push(warn(`Unknown client: ${clientName}`));
      lines.push('');
      lines.push('Available clients:');
      for (const c of CLIENTS) {
        lines.push(`  • ${c.name} — ${c.displayName}`);
      }
      return lines.join('\n');
    }

    lines.push(`── ${client.displayName} ──`);
    lines.push(...setupClient(client, profile));
  }

  lines.push('');
  lines.push('Next steps:');
  lines.push('  1. Install the EasyEDA Pro bridge extension:');
  lines.push(`     npx ${SERVER_NAME} extension`);
  lines.push('  2. Restart your MCP client to load the new server.');
  lines.push('  3. Open a project in EasyEDA Pro, then click MCP Bridge > Connect.');

  return lines.join('\n');
}

// ── Public: extension command ───────────────────────────────

export function runExtension(options: SetupOptions): string {
  const extPath = getExtensionPath();
  const exists = existsSync(extPath);
  const lines: string[] = ['easyeda-mcp-pro extension', ''];

  if (exists) {
    lines.push(ok(`Extension package found`));
    lines.push(info(`Path: ${extPath}`));
  } else {
    lines.push(warn('Extension package not found.'));
    lines.push(info(`Expected at: ${extPath}`));
    lines.push('');
    lines.push('Build it with:');
    lines.push('  pnpm build:extension');
    return lines.join('\n');
  }

  if (options.open) {
    lines.push('');
    lines.push(info('Opening extension file location...'));
    openFileLocation(extPath);
  }

  if (options.copy) {
    const dest = join(options.copy, 'easyeda-bridge-extension.eext');
    try {
      const data = readFileSync(extPath);
      const destDir = dirname(dest);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      writeFileSync(dest, data);
      lines.push(ok(`Copied to ${dest}`));
    } catch (err) {
      lines.push(warn(`Failed to copy: ${err}`));
    }
  }

  lines.push('');
  lines.push('Installation:');
  lines.push('  1. Open EasyEDA Pro');
  lines.push('  2. Go to Settings → Extensions → Extension Manager');
  lines.push('  3. Click "Import Extension" and select the .eext file above');
  lines.push('  4. Enable "Allow External Interaction" for the extension');
  lines.push('  5. Click MCP Bridge → Connect in the menu bar');

  return lines.join('\n');
}

// ── Public: list available clients ──────────────────────────

export function formatClientList(): string {
  const lines: string[] = ['easyeda-mcp-pro — supported MCP clients', ''];

  const detected = detectInstalledClients();

  for (const client of CLIENTS) {
    const isDetected = detected.some((d) => d.name === client.name);
    const configPath = findConfigPath(client);
    const hasConfig = configPath ? existsSync(configPath) : false;
    const hasEntry =
      hasConfig && configPath ? configHasServer(configPath, client.serverKey) : false;

    let status: string;
    if (hasEntry) {
      status = '✅ configured';
    } else if (isDetected) {
      status = '🔵 detected';
    } else {
      status = '⚪ not found';
    }

    lines.push(`  ${status}  ${client.displayName} (${client.name})`);
  }

  lines.push('');
  lines.push('Usage:');
  lines.push(`  npx ${SERVER_NAME} setup <client>     Configure a specific client`);
  lines.push(`  npx ${SERVER_NAME} setup all          Configure all detected clients`);
  lines.push(`  npx ${SERVER_NAME} setup claude       Example: Claude Desktop`);
  lines.push('');
  lines.push('Options:');
  lines.push('  --profile <name>    Tool profile: core (default), pro, full, dev');

  return lines.join('\n');
}

// ── Interactive Setup Wizard ────────────────────────────────

export async function runInteractiveInit(): Promise<void> {
  const rl = createInterface({ input, output });

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║               easyeda-mcp-pro Setup Wizard               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();

  try {
    // 1. Client Choice
    console.log('Step 1: Choose MCP Client to Configure');
    console.log('--------------------------------------');
    const detected = detectInstalledClients();
    const clientOptions: Array<{ name: ClientName; display: string }> = [
      { name: 'claude', display: 'Claude Desktop' },
      { name: 'cursor', display: 'Cursor IDE' },
      { name: 'vscode', display: 'VS Code (Copilot)' },
      { name: 'windsurf', display: 'Windsurf (Codeium)' },
      { name: 'cline', display: 'Cline' },
      { name: 'gemini', display: 'Gemini CLI / Antigravity' },
      { name: 'zed', display: 'Zed Editor' },
      { name: 'amazonq', display: 'Amazon Q Developer' },
      { name: 'continue', display: 'Continue.dev' },
    ];

    for (const [index, opt] of clientOptions.entries()) {
      const isDet = detected.some((d) => d.name === opt.name);
      console.log(`  ${index + 1}. ${opt.display}${isDet ? ' (Detected 🔵)' : ''}`);
    }
    console.log(`  ${clientOptions.length + 1}. Configure All Detected`);
    console.log();

    let clientChoiceIndex = -1;
    while (true) {
      const answer = await rl.question(`Select client [1-${clientOptions.length + 1}]: `);
      const val = parseInt(answer.trim(), 10);
      if (val >= 1 && val <= clientOptions.length + 1) {
        clientChoiceIndex = val - 1;
        break;
      }
      console.log('Invalid choice. Please select a valid number.');
    }

    const selectedClient =
      clientChoiceIndex === clientOptions.length ? 'all' : clientOptions[clientChoiceIndex]?.name;
    if (!selectedClient) {
      throw new Error('Invalid client selection');
    }

    console.log();

    // 2. Profile Choice
    console.log('Step 2: Choose Tool Profile');
    console.log('---------------------------');
    console.log('  1. core   - Basic tools for normal workflow (default)');
    console.log('  2. pro    - Core tools + manufacturing exports (Gerber, PDF, pick-place)');
    console.log('  3. full   - Pro tools + documented EasyEDA API full control');
    console.log('  4. dev    - Full tools + runtime/bridge debugging probes');
    console.log();

    let profileChoice = 'core';
    while (true) {
      const answer = await rl.question('Select profile [1-4, default 1]: ');
      const val = answer.trim();
      if (!val) {
        profileChoice = 'core';
        break;
      }
      const num = parseInt(val, 10);
      if (num === 1) {
        profileChoice = 'core';
        break;
      }
      if (num === 2) {
        profileChoice = 'pro';
        break;
      }
      if (num === 3) {
        profileChoice = 'full';
        break;
      }
      if (num === 4) {
        profileChoice = 'dev';
        break;
      }
      console.log('Invalid choice. Please select a valid number.');
    }

    console.log();

    // 3. Extension Choice
    console.log('Step 3: Setup EasyEDA Pro Bridge Extension');
    console.log('------------------------------------------');
    console.log('  1. Open folder containing extension package (.eext)');
    console.log('  2. Copy extension package to a custom folder');
    console.log('  3. Skip for now');
    console.log();

    let extChoice = 3;
    while (true) {
      const answer = await rl.question('Select option [1-3, default 1]: ');
      const val = answer.trim();
      if (!val) {
        extChoice = 1;
        break;
      }
      const num = parseInt(val, 10);
      if (num >= 1 && num <= 3) {
        extChoice = num;
        break;
      }
      console.log('Invalid choice. Please select a valid number.');
    }

    let copyTarget: string | undefined;
    if (extChoice === 2) {
      while (true) {
        const answer = await rl.question('Enter destination directory path: ');
        const dir = answer.trim();
        if (dir) {
          copyTarget = dir;
          break;
        }
        console.log('Path cannot be empty.');
      }
    }

    console.log();
    console.log('=== Configuring... ===');
    console.log();

    // Perform Client Setup
    const setupResult = runSetup({ client: selectedClient, profile: profileChoice });
    console.log(setupResult);

    console.log();

    // Perform Extension Setup
    if (extChoice === 1) {
      const extResult = runExtension({ open: true });
      console.log(extResult);
    } else if (extChoice === 2 && copyTarget) {
      const extResult = runExtension({ copy: copyTarget });
      console.log(extResult);
    } else {
      console.log('Extension setup skipped. You can always run:');
      console.log('  npx easyeda-mcp-pro extension --open');
    }

    console.log();
    console.log('════════════════════════════════════════════════════════════');
    console.log('🎉 Setup wizard complete! Please restart your client IDE.');
    console.log('════════════════════════════════════════════════════════════');
  } catch (err) {
    logError('Error during setup wizard', err);
  } finally {
    rl.close();
  }
}
