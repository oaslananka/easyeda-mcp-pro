#!/usr/bin/env tsx
import process from 'node:process';
import { BridgeManager } from '../src/bridge/manager.js';
import { loadEnvConfig } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';
import {
  parseLiveSmokeConfig,
  runLiveSmokeChecks,
  skippedLiveSmokeReport,
  validateLiveSmokeConfig,
  writeLiveSmokeReport,
} from '../src/live/easyeda-smoke.js';

const smokeConfig = parseLiveSmokeConfig(process.env);

async function main(): Promise<void> {
  if (!smokeConfig.enabled) {
    const report = skippedLiveSmokeReport('EASYEDA_LIVE_TESTS is not enabled.', smokeConfig);
    await writeLiveSmokeReport(smokeConfig.outputPath, report);
    console.log(
      `EasyEDA live smoke skipped. Set EASYEDA_LIVE_TESTS=true and EASYEDA_TEST_PROJECT_ID to run it. Report: ${smokeConfig.outputPath}`,
    );
    return;
  }

  const configErrors = validateLiveSmokeConfig(smokeConfig);
  if (configErrors.length > 0) {
    throw new Error(configErrors.join(' '));
  }

  const envConfig = loadEnvConfig();
  createLogger(envConfig);
  const bridge = new BridgeManager(envConfig);
  const report = await runLiveSmokeChecks(bridge, smokeConfig);
  await writeLiveSmokeReport(smokeConfig.outputPath, report);
  console.log(
    `EasyEDA live smoke ${report.status}. ${report.checks.length} checks written to ${smokeConfig.outputPath}`,
  );

  if (report.status === 'failed') {
    process.exitCode = 1;
  }
}

await main();
