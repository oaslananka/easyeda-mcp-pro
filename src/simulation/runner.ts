/**
 * ngspice detection and sandboxed batch execution.
 *
 * Always uses `execFile` (never `exec`/`spawn` with `shell: true`), so deck content is
 * never interpreted by a shell. The deck is written to a dedicated, freshly-created temp
 * directory that is removed afterward regardless of success or failure.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NgspiceAvailability } from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_NGSPICE_BINARY = 'ngspice';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function detectNgspice(binary = DEFAULT_NGSPICE_BINARY): Promise<NgspiceAvailability> {
  try {
    const { stdout } = await execFileAsync(binary, ['-v'], { timeout: 5_000 });
    const versionMatch = /ngspice[^\d]*([\d.]+)/i.exec(stdout);
    return { available: true, version: versionMatch?.[1] ?? stdout.trim().split('\n')[0] };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RunNgspiceOptions {
  binary?: string;
  timeoutMs?: number;
}

export interface RunNgspiceResult {
  stdout: string;
  stderr: string;
}

/** Run an ngspice deck in batch mode inside a scratch temp directory. */
export async function runNgspiceDeck(
  deck: string,
  options: RunNgspiceOptions = {},
): Promise<RunNgspiceResult> {
  const binary = options.binary ?? DEFAULT_NGSPICE_BINARY;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scratchDir = await mkdtemp(join(tmpdir(), 'easyeda-spice-'));
  const deckPath = join(scratchDir, 'deck.cir');
  try {
    await writeFile(deckPath, deck, 'utf-8');
    const { stdout, stderr } = await execFileAsync(binary, ['-b', deckPath], {
      cwd: scratchDir,
      timeout,
    });
    return { stdout, stderr };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
