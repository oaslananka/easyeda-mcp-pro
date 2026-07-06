#!/usr/bin/env tsx
import process from 'node:process';
import { parseNgspiceLiveConfig, runNgspiceLiveSmoke } from '../src/live/ngspice-smoke.js';

const config = parseNgspiceLiveConfig(process.env);

async function main(): Promise<void> {
  const report = await runNgspiceLiveSmoke(config);
  console.log(`ngspice live smoke: ${report.status} — ${report.detail}`);
  if (report.ngspiceVersion) console.log(`ngspice version: ${report.ngspiceVersion}`);
  if (report.expectedVoltage !== undefined) {
    console.log(`expected: ${report.expectedVoltage}V, observed: ${report.observedVoltage}V`);
  }

  if (report.status === 'failed') {
    process.exitCode = 1;
  }
}

await main();
