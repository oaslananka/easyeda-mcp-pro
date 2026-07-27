import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackageArtifacts } from './package-artifacts.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.env.PACKAGE_POLICY_ROOT || repoRoot);
const result = await verifyPackageArtifacts({ root });

if (!result.ok) {
  console.error(`[package:check] FAILED — ${result.errors.length} error(s)`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('[package:check] PASSED — package artifacts are fresh and complete');
