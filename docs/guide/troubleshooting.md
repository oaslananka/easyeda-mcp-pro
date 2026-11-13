# Troubleshooting

If your AI assistant is unable to communicate with EasyEDA Pro or throws errors, use this guide to identify and fix the issue.

---

## 1. Run Diagnostics

The first step is to check if the MCP server is correctly installed and built:

```bash
npx easyeda-mcp-pro --doctor
```

This diagnostic tool checks:

- Node.js runtime version compatibility.
- Whether it is running from a source checkout, installed package, or production runtime.
- Whether `dist/index.js` is non-empty and has the declared Node.js shebang.
- Whether `easyeda-bridge-extension.eext` matches its bundled SHA-256 manifest.
- Availability and reachability of local port `49620`.

pnpm is required and version-checked only in a source checkout. pnpm is not required in an installed package or production runtime. If a runtime artifact is missing or corrupt, reinstall the package or container image instead of adding development tooling to production.
The command exits with status `1` for these fatal runtime/configuration defects, while an offline bridge alone remains an informational result.

---

## 2. Bridge Connection Issues

If you receive errors like `Bridge not connected` during tool execution:

### Possible Causes:

1. **EasyEDA Pro is closed**: Open EasyEDA Pro and open a project.
2. **Bridge Extension is not installed**: Follow the [Getting Started Guide](./getting-started) to import the `.eext` file.
3. **Eklenti Devre Dışı / External Interaction is Off**: Open the Extension Manager in EasyEDA Pro, select "MCP Pro Bridge", and make sure **Allow External Interaction** is checked. EasyEDA Pro v3 can block the bridge silently when this permission is off.
4. **Bridge is not Connected**: In the menu bar of EasyEDA Pro, click **MCP Bridge** → **Connect**. You should see a toast message saying _Bridge server connected_.
5. **Port conflict or Firewall**: The bridge binds to local port `49620` by default. Ensure no other application is using this port and your firewall allows localhost WebSocket connections.
6. **Another MCP process owns the bridge**: Only one local `easyeda-mcp-pro` process owns the EasyEDA bridge listener at a time. If another client window or an orphaned MCP process owns it, `easyeda_health_check` and `easyeda_bridge_status` report `blocked_by_other_instance: true` with the owner PID and listener port. Close the other MCP client, or terminate the reported stale process, then restart the blocked client.

---

## Multi-unit schematic symbols return SUBPART_PLACEMENT_UNVERIFIED

If `easyeda_schematic_place_component` is given `subPartName` (for example
`OPA2333AIDR.1`), **both preview (`dryRun`) and apply** refuse the request
before reading or changing the schematic. Compound schematic workflows
(`easyeda_workflow_place_block` and `easyeda_workflow_connector_breakout`)
also mark such plans blocked before performing any operation. This is intentional: while the
[EasyEDA Pro beta API documents a `subPartName` argument](https://prodocs.easyeda.com/en/api/reference/pro-api.sch_primitivecomponent.create.html),
this MCP bridge has not verified correct selection, shared component identity,
pins, package, and BOM handling for multi-unit devices in a native EasyEDA
session. A dry-run success must not promise a later write will work.

For now, open the schematic in the **EasyEDA Pro editor** and place the
remaining symbol units using the editor's multi-part component workflow.
Inspect the resulting pins and designators, then check that all sections map
to the intended shared package and **one BOM component** before wiring or
manufacturing. Do **not** approximate a multi-part device by placing
independent full devices with separate reference designators; that can produce
duplicate package/BOM entries. The automated MCP multi-unit workflow remains
unsupported until native source-matched read-back acceptance is available.

---

## 3. Node.js Version Error

The MCP server supports Node.js **24.x**. Repository automation is pinned to **24.22.3**, and local pnpm workflows require exactly **11.28.11**.

If you see compilation or runtime errors:

1. Run `node -v` and `pnpm --version` to check both runtimes.
2. Restore the pinned toolchain:

   ```bash
   nvm install 24.22.3
   nvm use 24.22.3
   corepack enable
   corepack prepare pnpm@11.28.11 --activate
   node scripts/check-runtime.mjs --require-pnpm
   ```

3. Use `nvm` or your platform package manager to update:
   ```bash
   nvm install 24.22.3
   nvm use 24.22.3
   ```
