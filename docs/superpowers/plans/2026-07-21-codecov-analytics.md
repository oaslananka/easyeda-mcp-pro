# Codecov Analytics and Extension Size Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload server/extension coverage, JUnit results, and extension bundle trends to Codecov, and fail CI when EasyEDA extension artifacts exceed repository-owned byte budgets.

**Architecture:** The existing Ubuntu/Node 24 quality job remains the single analytics producer. Vitest emits component-specific LCOV and JUnit files, a SHA-pinned Codecov action uploads them, Codecov's general analyzer reports the custom esbuild output, and a small Node CLI enforces JSON-configured artifact budgets after the extension build.

**Tech Stack:** GitHub Actions, Vitest 4.1.9, V8 coverage, Codecov Action 6.0.1, Codecov CLI 11.3.1, `@codecov/bundle-analyzer` 2.0.1, Node.js 24.

## Global Constraints

- Do not add `@codecov/vite-plugin`; use exact-pinned `@codecov/bundle-analyzer@2.0.1` for the custom esbuild output.
- Pin `codecov/codecov-action` to `cddd853df119a48c5be31a973f8cd97e12e35e16`.
- Pin Codecov CLI to `v11.3.1`.
- Use `secrets.CODECOV_TOKEN`; skip analytics uploads for fork pull requests.
- Keep Codecov project and patch statuses informational initially.
- Preserve the existing local coverage thresholds.
- Use byte budgets of 200,000 for the `.eext`, 260,000 for `dist/index.js`, and 185,000 for `dist/dispatcher.js`.

---

### Task 1: Lock the analytics policy with failing tests

**Files:**

- Create: `tests/unit/repository/codecov-policy.test.ts`
- Create: `tests/unit/repository/extension-size-budget.test.ts`

**Interfaces:**

- Consumes: repository text files and the Node executable.
- Produces: policy assertions and CLI behavior expectations used by later tasks.

- [x] **Step 1: Write the failing Codecov policy test**
- [x] **Step 2: Write the failing size-checker behavior test**
- [x] **Step 3: Run both tests and verify RED**

### Task 2: Generate and upload Codecov reports

**Files:**

- Create: `codecov.yml`
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/unit/repository/codecov-policy.test.ts`

- [x] **Step 1: Add CI report scripts**
- [x] **Step 2: Guarantee LCOV output**
- [x] **Step 3: Add informational Codecov policy**
- [x] **Step 4: Replace duplicate server test runs in the quality job**
- [x] **Step 5: Add four explicit Codecov uploads**
- [x] **Step 6: Run the policy test and report-generation commands**

### Task 3: Report and enforce extension artifact sizes

**Files:**

- Create: `config/extension-size-budget.json`
- Create: `scripts/check-extension-size-budget.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/unit/repository/extension-size-budget.test.ts`

- [x] **Step 1: Add the budget configuration**
- [x] **Step 2: Implement the size checker**
- [x] **Step 3: Add the general Codecov bundle analyzer**
- [x] **Step 4: Expose and wire the blocking byte check**
- [x] **Step 5: Verify GREEN**

### Task 4: Validate, document, and publish the change

- [x] **Step 1: Validate workflow syntax and formatting**
- [x] **Step 2: Run the complete repository verification**
- [x] **Step 3: Review the diff and commit**
- [ ] **Step 4: Push and open a pull request**
- [ ] **Step 5: Check all bot and agent feedback**
- [ ] **Step 6: Integrate only after all required checks pass**
