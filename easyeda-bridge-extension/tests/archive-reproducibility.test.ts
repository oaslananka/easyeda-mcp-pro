import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeExtensionArchive } from '../scripts/archive.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writePackageInputs(root: string, lineEnding: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'images'), { recursive: true });

  for (const [file, content] of [
    ['README.md', '# Example\nAn extension\n'],
    ['CHANGELOG.md', '# Changelog\n- Fix\n'],
    ['extension.json', '{\n  "name": "test"\n}\n'],
  ]) {
    writeFileSync(join(root, file), content.replaceAll('\n', lineEnding));
  }
  // Generated runtime bundles already have canonical line endings.
  writeFileSync(join(root, 'dist', 'index.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'dist', 'dispatcher.meta.json'), '{\n  "count": 1\n}\n');
  // The archive must also support binary content without text conversion.
  writeFileSync(
    join(root, 'images', 'logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
  );
}

describe('extension package reproducibility', () => {
  it('produces the same archive for LF and CRLF working-tree text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'easyeda-eext-eol-'));
    temporaryDirectories.push(directory);
    const lfRoot = join(directory, 'lf');
    const crlfRoot = join(directory, 'crlf');
    writePackageInputs(lfRoot, '\n');
    writePackageInputs(crlfRoot, '\r\n');

    const lfArchive = join(directory, 'lf.eext');
    const crlfArchive = join(directory, 'crlf.eext');
    const date = new Date('2026-11-10T00:00:00.000Z');
    await writeExtensionArchive({ root: lfRoot, packagePath: lfArchive, date });
    await writeExtensionArchive({ root: crlfRoot, packagePath: crlfArchive, date });

    expect(readFileSync(crlfArchive)).toEqual(readFileSync(lfArchive));
  });
});
