import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [inputArg, outputArg, prefixArg] = process.argv.slice(2);

if (!inputArg || !outputArg || !prefixArg) {
  console.error(
    'usage: node scripts/prepare-sonar-coverage.mjs <input-lcov> <output-lcov> <source-prefix>',
  );
  process.exit(2);
}

const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const prefix = prefixArg
  .replaceAll('\\', '/')
  .replace(/^\.?\//, '')
  .replace(/\/?$/, '/');

if (!prefix || prefix.startsWith('../') || prefix.startsWith('/')) {
  throw new Error(`invalid source prefix: ${prefixArg}`);
}

const input = readFileSync(inputPath, 'utf8');
let sourceFiles = 0;

const output = input
  .split(/\r?\n/)
  .map((line) => {
    if (!line.startsWith('SF:')) return line;

    const source = line.slice(3).replaceAll('\\', '/').replace(/^\.\//, '');
    if (
      !source ||
      source.startsWith('/') ||
      /^[A-Za-z]:\//.test(source) ||
      source.startsWith('../')
    ) {
      throw new Error(`LCOV source path must be repository-relative: ${source || '<empty>'}`);
    }

    sourceFiles += 1;
    const normalizedSource = source.startsWith(prefix) ? source : prefix + source;
    return `SF:${normalizedSource}`;
  })
  .join('\n');

if (sourceFiles === 0) {
  throw new Error(`LCOV report contains no SF records: ${inputArg}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output);
console.log(`Prepared ${sourceFiles} Sonar LCOV source paths in ${outputArg}`);
