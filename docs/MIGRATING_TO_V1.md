# Migrating to v1

`1.0.1-rc.1` is the patch candidate for the security/correctness hardening merged after stable `1.0.0`. It preserves the public MCP and bridge contracts while validating cryptographic reconnect jitter, trusted helper/Python launcher resolution, chronological provenance ordering, and deterministic EasyEDA runtime identifier ordering before stable `1.0.1` promotion. After RC.1 is published and verified, npm/GHCR `next` point to RC.1 while stable channels remain on `1.0.0`.

## What stays compatible

- Existing MCP tool names, tool profiles, and the default `core` profile remain unchanged.
- Existing stdio and loopback bridge configurations continue to work.
- No database or project-file migration is required.
- Remote Relay remains experimental behind `MCP_BRIDGE_BACKEND=remote_relay`; v1 does not promote it to beta or stable.
- Raw EasyEDA JavaScript execution remains disabled unless both experimental gates are explicitly enabled.

## Upgrade to the release candidate

1. Install the prerelease server without moving your stable configuration:

   ```bash
   npm install --global easyeda-mcp-pro@next
   easyeda-mcp-pro --doctor
   ```

   An MCP client can also test the candidate with `npx -y easyeda-mcp-pro@next`.

2. Download the matching `easyeda-bridge-extension.eext` asset from the `easyeda-mcp-pro-v1.0.1-rc.1` GitHub prerelease.
3. In EasyEDA Pro, replace the existing MCP Pro Bridge extension with that asset and enable **Allow External Interaction**. EasyEDA Pro 3.2.149 accepts this standard SemVer prerelease package identity, so Extension Manager and the bridge runtime both report `1.0.1-rc.1`. The earlier `1.0.0-rc.N` candidates retain their published `0.99.N` install identities for compatibility.
4. Start the MCP server and confirm:
   - `easyeda_health_check` returns `status: ok`;
   - server and extension versions both report `1.0.1-rc.1`;
   - `extension_version_mismatch` and `registry_mismatch` are both `false`.
5. Re-run the workflows your project depends on before using the candidate for production work.

## Roll back to 1.0.0

The release candidate does not move stable channels. To return explicitly to the previous stable version:

```bash
npm install --global easyeda-mcp-pro@1.0.0
easyeda-mcp-pro --doctor
```

For container deployments, pin `ghcr.io/oaslananka/easyeda-mcp-pro:1.0.0`. Reinstall the `1.0.0` extension asset from the corresponding GitHub release so the server and extension versions remain aligned.

## Reporting candidate regressions

Open a GitHub issue with the EasyEDA Pro version, server/extension versions, `easyeda_health_check`, `easyeda_bridge_status`, and a sanitized reproduction. Do not attach private design files, credentials, or raw project data to a public issue.
