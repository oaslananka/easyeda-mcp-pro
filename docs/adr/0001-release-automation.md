# ADR 0001: Release Automation using Release Please

## Status

Accepted

## Context

In a collaborative codebase, managing version bumps, updating configuration files, and generating changelogs manually is error-prone and slows down delivery. We need a system that:

1. Automatically tracks what changes are introduced (e.g. features, bug fixes, breaking changes).
2. Generates semantic versioning (SemVer) numbers.
3. Maintains a clean `CHANGELOG.md`.
4. Automates updates to version declarations in multiple files (like `package.json`, `server.json`, and `extension.json`).

## Decision

We choose **Release Please** (specifically `googleapis/release-please-action` v5) to automate our release management.

- The root project will use the `node` release strategy.
- We will leverage the `extra-files` configuration to automatically synchronize version numbers in `server.json` and `easyeda-bridge-extension/extension.json` when a new release is generated.
- Version bumps are triggered automatically based on Conventional Commits merged to `main`.
- Release Please and GitHub Release asset mutations use the repository-scoped `RELEASE_PLEASE_TOKEN`. The token is restricted to Contents, Pull requests, and Issues read/write access for this repository; it is not exposed to build, npm, MCP Registry, or GHCR publication steps.

## Consequences

- **Pros**:
  - Eliminates human error in semantic versioning and changelog updates.
  - Automatically drafts release notes and updates all files in a single PR.
  - Integration with GitHub Actions allows publishing to NPM and uploading release assets immediately upon merging a Release PR.
- **Cons**:
  - Requires developers to strictly follow the Conventional Commits specification.
