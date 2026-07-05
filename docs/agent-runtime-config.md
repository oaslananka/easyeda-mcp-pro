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

## Cursor and other MCP clients

Most MCP-compatible clients can use the same stdio launch command:

```bash
npx easyeda-mcp-pro
```

For HTTP transport, use an explicit transport environment:

```bash
TRANSPORT=http HTTP_HOST=127.0.0.1 HTTP_PORT=3000 npx easyeda-mcp-pro
```

## Validation checklist

1. Confirm the command starts: `npx easyeda-mcp-pro --help`.
2. Validate plugin metadata: `claude plugin validate .`.
3. Install and enable the EasyEDA bridge extension for live EasyEDA Pro project workflows.
4. Start an MCP-capable client with the configured server.
5. Call safe diagnostics such as `easyeda_health_check`, `easyeda_bridge_status`, or `easyeda_get_capabilities`.
6. Use write tools only after bridge status, `TOOL_PROFILE`, and user permission are clear.

## Safety

EasyEDA MCP Pro is an engineering assistant, not a manufacturing sign-off authority. DRC, ERC, BOM, sourcing, export artifacts, and all generated changes require human engineering review.
