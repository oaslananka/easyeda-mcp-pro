#!/usr/bin/env tsx
import process from 'node:process';
import { BridgeManager } from '../src/bridge/manager.js';
import { loadEnvConfig } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';
import {
  captureRuntimeInventorySnapshot,
  parseRuntimeInventoryCaptureConfig,
  writeRuntimeInventorySnapshot,
} from '../src/easyeda-runtime/inventory.js';

const config = parseRuntimeInventoryCaptureConfig(process.env);

if (!config.enabled) {
  console.log(
    'EasyEDA runtime inventory capture skipped. Set EASYEDA_RUNTIME_INVENTORY_CAPTURE=true to capture from a live bridge.',
  );
  process.exit(0);
}

const envConfig = loadEnvConfig();
createLogger(envConfig);
const bridge = new BridgeManager(envConfig);
const snapshot = await captureRuntimeInventorySnapshot(bridge, config);
if (!snapshot) {
  throw new Error('Runtime inventory capture unexpectedly returned no snapshot.');
}
await writeRuntimeInventorySnapshot(config.outputPath, snapshot);
console.log(`Captured ${snapshot.total} EasyEDA runtime classes to ${config.outputPath}`);
