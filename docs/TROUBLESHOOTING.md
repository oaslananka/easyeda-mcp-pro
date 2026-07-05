# Troubleshooting Guide

This guide helps resolve common issues encountered while setting up and running `easyeda-mcp-pro`.

---

## 1. MCP Client Cannot Start the Server

### Symptom:

The AI client (e.g. Claude Desktop or Cursor) displays an error: `"Failed to start MCP server"` or `"Process exited with code 1"`.

### Resolving Node.js and Command Conflicts:

1. **Wrong Node.js version**: Ensure your system path uses **Node.js >= 24**. Run `node -v` to verify.
2. **Global `npx` not found**: If `npx` is not in the system PATH, specify the absolute path to `node` and pointing to `dist/index.js` instead.
3. **Execution Policy (Windows)**: In Windows PowerShell, if scripts are disabled, use `.cmd` commands or run from command prompt (`cmd`).

---

## 2. EasyEDA Bridge Disconnected

### Symptom:

`easyeda_health_check` shows `bridge_connected: false` and tools targeting the schematic/PCB return `not_available` or WebSocket timeouts.

### Checklist:

1. **Connect via Menu**: In EasyEDA Pro, verify that you clicked **MCP Bridge** → **Connect** in the menu bar. If connected, the menu should display a checkmark or status indicating active socket connections.
2. **Extension Permissions**: Go to **Settings** → **Extensions** → **Extension Manager** and make sure **Allow External Interaction** is checked for the MCP Pro Bridge extension. Without this, EasyEDA blocks external WebSocket connections and some EasyEDA v3 builds fail silently before any socket is opened.
3. **Port Conflict**: The bridge defaults to port `49620`. If it is in use by another application, the extension will fail to bind. Run the doctor tool to diagnose:
   ```bash
   npx easyeda-mcp-pro doctor
   ```
   Add `--fix` to print a suggested-fixes section with the exact command or setting to
   change for each detected failure (Node version, missing pnpm, invalid env, missing
   build artifacts, unreachable bridge port, missing vendor credentials). `doctor --fix`
   never modifies files — it only prints guidance.
4. **Port Scan Configuration**: If you changed ports, ensure the server env var `BRIDGE_PORT` or `BRIDGE_PORT_SCAN` aligns with the extension's configured port (default is `49620`).
5. **Extension Version Mismatch**: `easyeda_health_check` and `easyeda_run_self_test` report
   `extension_version_mismatch: true` (and the mismatched versions) when the connected
   bridge extension's version differs from the installed `easyeda-mcp-pro` package
   version. Update the extension in EasyEDA Pro (Settings → Extensions → Extension
   Manager) or reinstall `easyeda-bridge-extension.eext` from a matching release.

---

## 3. Supplier API Credentials Missing

### Symptom:

Pricing or sourcing tools return `redacted` or empty supplier prices.

### Solution:

Verify that your credentials are set in the `.env` file at the directory where you start the server:

- JLCPCB requires `JLCPCB_CLIENT_ID` and `JLCPCB_CLIENT_SECRET` in `approved_api` mode.
- Mouser requires `MOUSER_API_KEY`.
- DigiKey requires `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET`.

---

## 4. HTTP Transport Blocked by OAuth Safety Check

### Symptom:

The server exits on startup when using `TRANSPORT=http` with the error:
`"Production safety check failed: Non-loopback HTTP host requires OAUTH_ENABLED=true."`

### Rationale & Solution:

For security, binding the server to an external network interface (e.g. `HTTP_HOST=0.0.0.0`) without active authentication is blocked to prevent exposing your local EasyEDA instance to the public web.
To bypass this locally, bind to `127.0.0.1`. For production deployments, configure `OAUTH_ENABLED=true` and provide a valid JWKS endpoint (`OAUTH_JWKS_URI`).

---

## 5. Stale MCP Client Config

### Symptom:

Running `npx easyeda-mcp-pro setup <client>` (or `setup all`) prints "Stale entry
detected and replaced" for a client instead of "Existing entry was already up to date."

### Rationale & Solution:

This means the client's MCP config file already had an `easyeda-mcp-pro` entry that
differed from the one `setup` just wrote (for example, an entry from an older version
that pointed at a local build path, or one missing a `TOOL_PROFILE` env var). The lines
under "Stale entry detected and replaced" list exactly what changed
(`command`, `args`, or `env`). `setup` always writes the correct current entry, so no
further action is needed — restart the client to pick up the corrected config.

---

## 6. Release Pipeline / NPM Token Failures

### Symptom:

The GitHub Actions release workflow fails on the `Publish to npm` step.

### Solution:

Verify that `NPM_TOKEN` is set in your repository's secrets. The workflow will explicitly check for it and fail with a clear, readable error if it is not configured.
If you get OIDC token failures, verify that your repository is not restricted from fetching OIDC tokens from `registry.npmjs.org` or GitHub's authentication service.
