# Live E2E helper scripts

These scripts are maintainer-only helpers for live EasyEDA bridge diagnostics and smoke validation. They are not part of the default end-user workflow.

## Shared harness

Scripts that start an MCP server must use `harness.mjs` instead of hand-rolled `spawn()` / `setTimeout(kill)` shutdown logic. The harness provides:

- stdio JSON-RPC request tracking,
- pending-request cleanup when the server exits,
- process-exit, SIGINT, and SIGTERM cleanup hooks,
- immediate SIGTERM/SIGKILL shutdown without a delayed timer race,
- captured stdout/stderr logs for diagnostics.

This prevents orphaned `dist/index.js` servers from accumulating and accidentally accepting the EasyEDA extension connection on the wrong port.

## Recommended dev bridge flow

1. Build the project before live runs: `pnpm build`.
2. In EasyEDA Pro, enable the MCP Bridge extension and turn Auto-Connect on when available.
3. Start one live helper, for example `node scripts/e2e/diag.mjs` or `node scripts/e2e/live.mjs`.
4. When the helper prints that it is waiting for bridge connection, connect or reconnect the EasyEDA MCP Bridge once.
5. Re-run helpers from the same terminal session as needed. The harness cleans up the child MCP server on every normal exit, failure, Ctrl+C, or termination signal.

If a run times out waiting for the bridge, close the helper, verify there is no stale `dist/index.js` process, then reconnect the EasyEDA bridge to the new helper instance.

## Scripts

- `diag.mjs` — bridge state, capabilities, tool registration, and health diagnostics.
- `live.mjs` — full live schematic net creation and connectivity validation.
- `waiter.mjs` — TCP bridge wait/debug helper for longer manual sessions.
- `http.mjs` — HTTP transport helper; it does not spawn a child MCP server.
