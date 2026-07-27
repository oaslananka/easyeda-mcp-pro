import { verifyRepositoryPackageScriptTargets } from './package-script-targets.mjs';

const result = await verifyRepositoryPackageScriptTargets();
if (!result.ok) {
  console.error(`[check:package-scripts] FAILED — ${result.errors.length} error(s)`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `[check:package-scripts] PASSED — ${result.checkedTargets} local target(s) across ${result.checkedPackages} package(s)`,
);
