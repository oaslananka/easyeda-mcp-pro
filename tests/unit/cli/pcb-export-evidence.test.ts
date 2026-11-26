import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPcbExportEvidence } from '../../../src/cli/pcb-export-evidence.js';

let dir: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('pcb-export-evidence local CLI', () => {
  it('provides help and does not read files for invalid arguments', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(runPcbExportEvidence(['--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(runPcbExportEvidence(['wrong', 'VCC', 'a', 'b'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('fails closed for a directory, oversized input and invalid UTF-8', () => {
    dir = mkdtempSync(join(tmpdir(), 'easyeda-export-evidence-'));
    const ipc = join(dir, 'ipc');
    const copper = join(dir, 'copper');
    writeFileSync(ipc, '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(runPcbExportEvidence(['top', 'VCC', dir, ipc])).toBe(2);
    writeFileSync(copper, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(runPcbExportEvidence(['top', 'VCC', copper, ipc])).toBe(2);
    writeFileSync(copper, Buffer.from([0xff]));
    expect(runPcbExportEvidence(['top', 'VCC', copper, ipc])).toBe(2);
    expect(stderr).toHaveBeenCalledTimes(3);
  });

  it('emits structured unknown electrical status for explicit supported files', () => {
    dir = mkdtempSync(join(tmpdir(), 'easyeda-export-evidence-'));
    const copper = join(dir, 'top.gtl');
    const ipc = join(dir, 'netlist');
    writeFileSync(
      copper,
      [
        'G04 Layer: TopLayer*',
        '%FSLAX45Y45*%',
        '%MOMM*%',
        '%ADD10C,1*%',
        'G54D10*',
        'G01X100000Y100000D03*',
        'M02*',
      ].join('\n'),
    );
    writeFileSync(
      ipc,
      [
        'P  UNITS  CUST 1',
        'P  VER   IPC-D-356A',
        '317VCC              C1    -1    D0500PA00X 001000Y 001000X1000Y         S0',
        '999',
      ].join('\n'),
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runPcbExportEvidence(['top', 'VCC', copper, ipc])).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      correlationStatus: 'MATCHED_OBSERVED_RECORDS',
      summary: { matched: 1, unmatched: 0, ambiguous: 0 },
      electricalContinuity: 'UNKNOWN',
      engineeringSignOff: false,
    });
  });
});
