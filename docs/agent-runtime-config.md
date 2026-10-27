# Agent Runtime Configuration

This document gives copyable configuration examples for running EasyEDA MCP Pro from popular MCP-capable agent runtimes.

## Claude Code

The repository includes both:

- `.claude-plugin/plugin.json` with a Claude Code-valid plugin manifest.
- `.mcp.json` with the MCP server definition for project-local Claude Code usage.

Validate the plugin locally:

```bash
claude plugin validate .
```

Run Claude Code with this plugin directory for one session:

```bash
claude --plugin-dir .
```

## Codex CLI

Use `.codex/config.example.toml` as a starting point. Copy the `[[mcp_servers]]` block into your Codex config file and adjust bridge or profile settings if needed.

## VS Code / GitHub Copilot

Use `.vscode/mcp.example.json` as a workspace MCP configuration example. If your VS Code profile already has MCP servers configured globally, copy only the `easyeda-mcp-pro` server block.

## OpenCode

Use `opencode.example.jsonc` as a project-level OpenCode MCP configuration example. Copy it to `opencode.json` in a working project, or merge the `mcp` block into an existing OpenCode config.

OpenCode discovers project-local skills from `.opencode/skills/<name>/SKILL.md`, so this repository mirrors the EasyEDA skills there for OpenCode-native loading.

Local MCP server command:

```bash
npx easyeda-mcp-pro
```

Typical prompt hint:

```text
Use the easyeda-mcp-pro MCP tools and the design-validation skill to validate this EasyEDA project.
```

## Cursor and other MCP clients

Most MCP-compatible clients can use the same stdio launch command:

```bash
npx easyeda-mcp-pro
```

For HTTP transport, use an explicit transport environment:

```bash
TRANSPORT=http HTTP_HOST=127.0.0.1 HTTP_PORT=3000 npx easyeda-mcp-pro
```

## Component datasheet, footprint and model review

Use `skills/easyeda-component-review/SKILL.md` to review a design component against
its manufacturer drawing and actual bound assets, then save scoped results and
structured evidence through `easyeda_library_update_device_metadata`. Runtime
wrappers are included for Codex, Agents, Claude and OpenCode; the canonical folder
also contains dependency-free Node helpers and the evidence contract.

Example request:

```text
Use $easyeda-component-review to review J1 in this design against its manufacturer
datasheet, check its footprint and actual 3D model, and save the findings and
evidence in my Personal library. Leave missing checks incomplete.
```

The metadata tool is available in core. Some native asset/copy/export operations
need additional documented capabilities or a manual native export; the skill
reports those limitations rather than enabling a broader profile silently.

## Verify feature maturity

Before relying on an optional capability, call `easyeda_get_feature_flags` or
`easyeda_get_capabilities` and inspect the `maturity`, `configured`, and `effective` fields. In
particular, AI provider, MCP Apps, MCP Tasks, MCP v2, and OTLP variables are currently reserved and
remain ineffective even if an agent runtime passes them in its environment. Remote Relay and raw
execution are experimental; OAuth/JWKS is implemented.

Do not infer support from the existence of an environment-variable name or from a configured value.

## Validation checklist

1. Confirm the command starts: `npx easyeda-mcp-pro --help`.
2. Validate plugin metadata: `claude plugin validate .`.
3. Install and enable the EasyEDA bridge extension for live EasyEDA Pro project workflows.
4. Start an MCP-capable client with the configured server.
5. Call safe diagnostics such as `easyeda_health_check`, `easyeda_bridge_status`, or `easyeda_get_capabilities`.
6. Use write tools only after bridge status, `TOOL_PROFILE`, and user permission are clear.

## Safety

EasyEDA MCP Pro is an engineering assistant, not a manufacturing sign-off authority. DRC, ERC, BOM, sourcing, export artifacts, and all generated changes require human engineering review.

## Experimental Skills over MCP

Set MCP_SKILLS_ENABLED=true to publish packaged design-validation and
easyeda-component-review skills through skills/list, skills/get and
resources/directory/read. Off by default while the SDK attachment API is
experimental. Only two audited, bundled directories are served; the server
never accepts an arbitrary user-specified folder. Skill instructions do not
grant CAD write permission or override MCP tool approvals.
