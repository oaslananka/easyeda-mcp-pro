import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { correlateExportGeometry } from '../pcb-layout/export-correlation.js';
import { MAX_EXPORT_BYTES } from '../pcb-layout/export-correlation-parsers.js';

const HELP = [
  'Usage: easyeda-mcp-pro pcb-export-evidence <top|bottom> <net> <copper-file> <ipc-file>',
  'Extract the selected copper Gerber layer from the EasyEDA Pro export ZIP first.',
  'Read-only local comparison of explicit files; JSON output, no EasyEDA connection.',
  'Supports only the observed metric EasyEDA export dialect; never electrical sign-off.',
].join('\n');

function readExport(path: string): string {
  // O_NONBLOCK prevents a FIFO from blocking the local process before fstat.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_EXPORT_BYTES) {
      throw new Error('Input must be a regular file no larger than 2 MiB.');
    }
    const buffer = Buffer.alloc(MAX_EXPORT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!n) break;
      offset += n;
    }
    const after = fstatSync(fd);
    if (
      offset > MAX_EXPORT_BYTES ||
      offset !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error('Input changed during reading or exceeds the size limit.');
    }
    // Preserve BOM so unsupported headers fail closed; fatal decoding avoids
    // hashing a modified replacement-character representation of the input.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, offset),
    );
  } finally {
    closeSync(fd);
  }
}

export function runPcbExportEvidence(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  const [layer, net, copper, ipc] = args;
  if (args.length !== 4 || (layer !== 'top' && layer !== 'bottom') || !net || !copper || !ipc) {
    process.stderr.write(HELP + '\n');
    return 2;
  }
  try {
    const result = correlateExportGeometry(readExport(copper), readExport(ipc), layer, net);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(
      `Export correlation unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}
