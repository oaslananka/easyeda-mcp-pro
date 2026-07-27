# Fail-Closed npm Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ensure `npm pack` from a clean checkout builds and validates every required runtime, extension, checksum, metadata, and legal artifact before producing a tarball.

**Architecture:** A repository-level package-artifact policy script will validate metadata alignment, the declared CLI target and shebang, the extension archive and checksum manifest, and the npm `files` allowlist. The `prepack` lifecycle will remove generated outputs, rebuild server and extension artifacts with the pinned runtime, and invoke the policy script. Repository tests will exercise missing, tampered, stale, and complete fixtures plus a real clean-pack smoke path.

**Tech Stack:** Node.js 24.18.0, pnpm 11.5.1, npm lifecycle scripts, TypeScript 6, Vitest 4, EasyEDA extension checksum utilities.

## Global Constraints

- Repository: `oaslananka/easyeda-mcp-pro`.
- Issue: `#422`.
- Required package contents: `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `config/runtime-policy.json`, `scripts/check-runtime.mjs`, `dist/index.js`, `easyeda-bridge-extension.eext`, and `easyeda-bridge-extension.checksums.json`.
- The package CLI must be declared as `easyeda-mcp-pro -> dist/index.js` and begin with `#!/usr/bin/env node`.
- Root package, `server.json`, `server.json packages[0]`, source version, extension manifest, and Claude plugin versions must remain aligned.
- Extension archive checksum verification must pass immediately before npm packaging.
- Generated outputs must be removed before the prepack build so stale files cannot survive into a tarball.
- No development-only source directories or credentials may be added to the npm package.

---

### Task 1: Package artifact policy

**Files:**

- Create: `scripts/check-package-artifacts.mjs`
- Create: `tests/unit/repository/package-artifacts-policy.test.ts`

**Interfaces:**

- Consumes: an optional `PACKAGE_POLICY_ROOT` fixture root, repository metadata, built CLI, extension archive, and checksum manifest.
- Produces: exit code `0` only when all required artifacts and metadata are valid; actionable stderr and exit code `1` otherwise.

- [x] **Step 1: Write failing fixture tests**

Create temporary package roots and spawn `node scripts/check-package-artifacts.mjs`. Cover: complete fixture; missing `dist/index.js`; wrong bin target; missing or wrong CLI shebang; version mismatch; missing extension archive; missing checksum manifest; tampered extension archive; and incomplete npm `files` allowlist.

- [x] **Step 2: Run the focused test and confirm RED**

```bash
pnpm vitest run tests/unit/repository/package-artifacts-policy.test.ts
```

Expected: failure because `scripts/check-package-artifacts.mjs` does not exist.

- [x] **Step 3: Implement the minimal checker**

Reuse `verifyChecksumManifest()` from `easyeda-bridge-extension/scripts/checksums.mjs`. Require the exact CLI declaration and required `files` entries, invoke the existing metadata checker for the real repository, validate fixture metadata directly, and reject empty artifacts.

- [x] **Step 4: Re-run the focused test and confirm GREEN**

```bash
pnpm vitest run tests/unit/repository/package-artifacts-policy.test.ts
```

### Task 2: Fail-closed prepack lifecycle

**Files:**

- Create: `scripts/prepare-package.mjs`
- Modify: `package.json`
- Modify: `scripts/clean.mjs`
- Test: `tests/unit/repository/package-artifacts-policy.test.ts`

**Interfaces:**

- Consumes: pinned Node.js and pnpm runtime plus source checkout.
- Produces: freshly rebuilt server `dist`, extension `dist`, `.eext`, checksum manifest, and a successful package policy result.

- [x] **Step 1: Add failing policy assertions**

Require `prepack` to run `pnpm runtime:check` and `node scripts/prepare-package.mjs`; require `prepare-package.mjs` to delete all generated outputs, run `pnpm build`, run `pnpm build:extension`, and run the package checker.

- [x] **Step 2: Run the focused test and confirm RED**

```bash
pnpm vitest run tests/unit/repository/package-artifacts-policy.test.ts
```

- [x] **Step 3: Implement the lifecycle**

Use `spawnSync` with inherited stdio and fail with the original nonzero status. Remove `dist`, `easyeda-bridge-extension/dist`, `easyeda-bridge-extension.eext`, and `easyeda-bridge-extension.checksums.json` before rebuilding.

- [x] **Step 4: Re-run focused tests and confirm GREEN**

```bash
pnpm vitest run tests/unit/repository/package-artifacts-policy.test.ts
```

### Task 3: Published package allowlist and CI smoke

**Files:**

- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/unit/repository/package-artifacts-policy.test.ts`

**Interfaces:**

- Consumes: npm tarball produced by the prepack lifecycle.
- Produces: package with all required runtime/legal files and CI verification of the tarball listing.

- [x] **Step 1: Add failing assertions for required legal/checksum files and tarball inspection**

Require `THIRD_PARTY_NOTICES.md` and `easyeda-bridge-extension.checksums.json` in `package.json.files`. Require CI to run a package-content checker after `npm pack` and upload the root checksum manifest path.

- [x] **Step 2: Run focused tests and confirm RED**

```bash
pnpm vitest run tests/unit/repository/package-artifacts-policy.test.ts
```

- [x] **Step 3: Update allowlist and CI**

Add the two files to the npm allowlist. Add `scripts/check-packed-tarball.mjs` only if tarball inspection cannot be expressed cleanly through the artifact checker; otherwise extend the checker with `--tarball` and inspect `npm pack --json` output plus `tar -tf`/Node tar metadata without widening package contents.

- [x] **Step 4: Run a real clean-pack smoke**

```bash
rm -rf dist easyeda-bridge-extension/dist easyeda-bridge-extension.eext easyeda-bridge-extension.checksums.json
npm pack --json
```

Expected: prepack performs the full build, the command exits `0`, and the tarball contains every required artifact.

### Task 4: Full verification and delivery

**Files:** all files changed above.

- [x] **Step 1: Run focused tests and package tamper checks**

```bash
pnpm vitest run tests/unit/repository/package-artifacts-policy.test.ts tests/unit/extension/checksums.test.ts tests/unit/repository/release-policy.test.ts
```

- [x] **Step 2: Run repository verification**

```bash
pnpm verify
```

- [x] **Step 3: Run clean `npm pack`, inspect the tarball, and install it in a fresh directory**

```bash
npm pack --json
npm install --ignore-scripts ./easyeda-mcp-pro-*.tgz
node -e "const fs=require('node:fs'); for (const p of ['node_modules/easyeda-mcp-pro/dist/index.js','node_modules/easyeda-mcp-pro/easyeda-bridge-extension.eext','node_modules/easyeda-mcp-pro/easyeda-bridge-extension.checksums.json','node_modules/easyeda-mcp-pro/THIRD_PARTY_NOTICES.md']) if (!fs.existsSync(p)) process.exit(1)"
```

- [x] **Step 4: Review diff, commit, push, open PR, wait for required checks, and merge**

```bash
git diff --check
git status --short
git commit -m "fix(release): make npm packaging fail closed (#422)"
```
