/**
 * Parse ngspice batch-mode stdout produced by the `print` control command (see
 * `buildSpiceDeck`). Two shapes are handled:
 *
 * - Operating point (`.op`), where `print` emits one `name = value` line per vector.
 * - Transient (`.tran`), where `print` emits an `Index  time  v(a)  v(b) ...` header
 *   followed by one numeric row per timepoint.
 *
 * This has been validated against the primary mocked-runner test suite documenting the
 * exact expected format, but **not against a live ngspice installation** (none is
 * available in this development environment) — see `docs/simulation.md`. Both parsers are
 * intentionally lenient about whitespace and are safe no-ops (return no data) on
 * unrecognized output rather than throwing, so a live-format mismatch degrades to an
 * empty/partial result instead of crashing the caller.
 *
 * @module
 */

import type { OperatingPointResult, TransientResult, TransientSample } from './types.js';

const OP_LINE = /^\s*([A-Za-z_][\w()]*)\s*=\s*([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s*$/;

export function parseOperatingPointOutput(stdout: string): OperatingPointResult {
  const nodeVoltages: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = OP_LINE.exec(line);
    if (!match) continue;
    const [, rawName, rawValue] = match;
    if (!rawName || !rawValue) continue;
    const name = normalizeVectorName(rawName);
    const value = Number(rawValue);
    if (Number.isFinite(value)) nodeVoltages[name] = value;
  }
  return { nodeVoltages };
}

function normalizeVectorName(name: string): string {
  const match = /^v\((\w+)\)$/i.exec(name);
  return match?.[1] ?? name;
}

// The index/value split only needs to locate the leading integer index and capture the
// rest of the row — individual numeric tokens are parsed (and validated) downstream via
// `.split(/\s+/).map(Number)` plus a `Number.isFinite` check, so this doesn't need to
// re-validate each number's exact format itself.
const NUMERIC_ROW = /^\s*(\d+)\s+(.+?)\s*$/;

export function parseTransientOutput(stdout: string): TransientResult {
  const lines = stdout.split(/\r?\n/);
  let columns: string[] | undefined;

  const samples: TransientSample[] = [];
  for (const line of lines) {
    if (!columns) {
      if (/\bindex\b/i.test(line) && /\btime\b/i.test(line)) {
        columns = line
          .trim()
          .split(/\s+/)
          .slice(1) // drop "Index"
          .map((name) => normalizeVectorName(name));
      }
      continue;
    }
    const match = NUMERIC_ROW.exec(line);
    const rawValues = match?.[2];
    if (!rawValues) continue;
    const values = rawValues.trim().split(/\s+/).map(Number);
    const timeIndex = columns.findIndex((name) => name.toLowerCase() === 'time');
    const timeValue = values[timeIndex];
    if (timeIndex === -1 || typeof timeValue !== 'number' || !Number.isFinite(timeValue)) continue;

    const nodeVoltages: Record<string, number> = {};
    columns.forEach((name, index) => {
      if (index === timeIndex) return;
      const value = values[index];
      if (typeof value === 'number' && Number.isFinite(value)) nodeVoltages[name] = value;
    });
    samples.push({ timeSeconds: timeValue, nodeVoltages });
  }
  return { samples };
}
