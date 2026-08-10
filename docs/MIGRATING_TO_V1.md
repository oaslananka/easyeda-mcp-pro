# Migrating to v1

`1.0.0-rc.2` is the next v1 release candidate after RC.1 was superseded by candidate-sensitive corrections. After RC.2 is published, npm `next` and the prerelease container channel point to RC.2 while npm/GHCR `latest` and the stable MCP Registry entry remain on `0.35.4`; candidate users must opt in through the prerelease channel.

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

2. Download the matching `easyeda-bridge-extension.eext` asset from the `easyeda-mcp-pro-v1.0.0-rc.2` GitHub prerelease.
3. In EasyEDA Pro, replace the existing MCP Pro Bridge extension with that asset and enable **Allow External Interaction**. EasyEDA Pro requires a numeric package version, so Extension Manager shows `0.99.2` for this RC; the bridge runtime still reports the product version `1.0.0-rc.2`.
4. Start the MCP server and confirm:
   - `easyeda_health_check` returns `status: ok`;
   - server and extension versions both report `1.0.0-rc.2`;
   - `extension_version_mismatch` and `registry_mismatch` are both `false`.
5. Re-run the workflows your project depends on before using the candidate for production work.

## Roll back to 0.35.4

The release candidate does not move stable channels. To return explicitly to the previous stable version:

```bash
npm install --global easyeda-mcp-pro@0.35.4
easyeda-mcp-pro --doctor
```

For container deployments, pin `ghcr.io/oaslananka/easyeda-mcp-pro:0.35.4`. Reinstall the `0.35.4` extension asset from the corresponding GitHub release so the server and extension versions remain aligned.

## Reporting candidate regressions

Open a GitHub issue with the EasyEDA Pro version, server/extension versions, `easyeda_health_check`, `easyeda_bridge_status`, and a sanitized reproduction. Do not attach private design files, credentials, or raw project data to a public issue.
