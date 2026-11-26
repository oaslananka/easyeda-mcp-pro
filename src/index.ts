#!/usr/bin/env node
import 'dotenv/config';
import {
  createDoctorReport,
  doctorExitCode,
  formatDoctorReport,
  formatHelp,
  formatSetupLocalReport,
  formatVersion,
  parseCliArgs,
} from './cli/local-setup.js';
import { runExtension, runSetup, runInteractiveInit } from './cli/auto-setup.js';
import type { SetupOptions } from './cli/client-definitions.js';
import { loadEnvConfig } from './config/env.js';
import { createServer } from './server/factory.js';
import { createHttpTransport } from './server/transports/http.js';
import { RemoteGateway } from './remote/gateway.js';
import { createHostedCloudRuntime } from './cloud/runtime.js';
import { createHostedUsageAuditLog } from './cloud/usage.js';
import { assertSupportedNodeRuntime } from './runtime/policy.js';
import { runPcbExportEvidence } from './cli/pcb-export-evidence.js';
import { runPrivateGroundCheck } from './cli/private-ground.js';

async function handleLocalCommand(): Promise<boolean> {
  if (process.argv[2] === 'pcb-export-evidence') {
    if (process.argv[3] !== '--help') assertSupportedNodeRuntime();
    process.exitCode = runPcbExportEvidence(process.argv.slice(3));
    return true;
  }
  if (['private-ground-check', 'private-ground-session'].includes(process.argv[2] ?? '')) {
    assertSupportedNodeRuntime();
    process.exitCode = await runPrivateGroundCheck(
      process.argv.slice(3),
      process.argv[2] === 'private-ground-session',
    );
    return true;
  }
  const cli = parseCliArgs(process.argv.slice(2));

  if (!['doctor', 'help', 'version'].includes(cli.command)) assertSupportedNodeRuntime();

  if (cli.command === 'init') {
    await runInteractiveInit();
    return true;
  }

  if (cli.command === 'setup') {
    process.stdout.write(
      `${runSetup({ client: cli.setupClient as SetupOptions['client'], profile: cli.setupProfile })}\n`,
    );
    return true;
  }

  if (cli.command === 'extension') {
    process.stdout.write(`${runExtension({ open: cli.extensionOpen, copy: cli.extensionCopy })}\n`);
    return true;
  }

  if (cli.command === 'setup-local') {
    process.stdout.write(`${formatSetupLocalReport()}\n`);
    return true;
  }

  if (cli.command === 'doctor') {
    const report = await createDoctorReport();
    process.stdout.write(`${formatDoctorReport(report, { fix: cli.doctorFix })}\n`);
    process.exitCode = doctorExitCode(report);
    return true;
  }

  if (cli.command === 'help') {
    process.stdout.write(`${formatHelp()}\n`);
    return true;
  }

  if (cli.command === 'version') {
    process.stdout.write(`${formatVersion()}\n`);
    return true;
  }

  return false;
}

async function main() {
  if (await handleLocalCommand()) return;
  const config = loadEnvConfig();
  const hostedCloud = await createHostedCloudRuntime(config);
  const registeredHostedToolNames = new Set<string>();
  const remoteGateway =
    config.MCP_BRIDGE_BACKEND === 'remote_relay'
      ? new RemoteGateway(
          hostedCloud
            ? {
                audit: createHostedUsageAuditLog(hostedCloud.usage, registeredHostedToolNames),
                resumeStore: hostedCloud.devices,
              }
            : {},
        )
      : undefined;
  const instance = await createServer(config, {
    remoteGateway,
    hostedOAuthResource: hostedCloud ? config.OAUTH_AUDIENCE : undefined,
  });

  // Populate the display-only allowlist from registered tools before HTTP
  // starts. Local mode does not use the Hosted Cloud audit callback.
  instance.registry.getEnabledTools().forEach((tool) => registeredHostedToolNames.add(tool.name));

  if (config.TRANSPORT === 'http') {
    const httpTransport = createHttpTransport(config, {
      gateway: remoteGateway,
      serverFactory: instance.createSessionServer,
      hostedAuth: hostedCloud?.auth,
      hostedUsage: hostedCloud?.usage,
    });
    instance.httpTransport = httpTransport;
    await httpTransport.start();
  } else {
    await instance.startStdio();
  }

  process.stderr.write(`easyeda-mcp-pro ready on ${config.TRANSPORT} transport\n`);

  const shutdown = async () => {
    try {
      await instance.httpTransport?.close();
      await instance.shutdown();
    } finally {
      hostedCloud?.close();
    }
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`Unhandled rejection: ${reason}\n`);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`Uncaught exception: ${err}\n`);
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`Critical server error: ${err}\n`);
  process.exit(1);
});
