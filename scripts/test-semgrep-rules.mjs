import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');

function runSemgrepRuleTests() {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'easyeda-mcp-pro-semgrep-'));

  try {
    copyFileSync(resolve(repoRoot, '.semgrep.yml'), resolve(tempDirectory, 'security-rules.yml'));
    copyFileSync(
      resolve(repoRoot, 'tests/semgrep/security-rules.fixture'),
      resolve(tempDirectory, 'security-rules.ts'),
    );

    const result = spawnSync(process.env.SEMGREP_BIN ?? 'semgrep', ['--test', tempDirectory], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SEMGREP_SEND_METRICS: 'off',
      },
      stdio: 'inherit',
    });

    if (result.error) {
      throw result.error;
    }

    return result.status ?? 1;
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
}

process.exitCode = runSemgrepRuleTests();
