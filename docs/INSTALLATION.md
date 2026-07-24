# Installation & Configuration Guide

This guide outlines the system requirements and setup options for `easyeda-mcp-pro`.

---

## 1. System Requirements

- **Node.js**: Node.js 24.x; source builds and automation are pinned to `24.18.0`.
- **pnpm**: exactly `11.5.1` for development workflows; not required for npx-only usage.
- **EasyEDA Pro**: use the [exact-version compatibility evidence](reference/easyeda-compatibility.md) for live-tested desktop runtimes.

```bash
nvm install 24.18.0
nvm use 24.18.0
corepack enable
corepack prepare pnpm@11.5.1 --activate
node scripts/check-runtime.mjs --require-pnpm
```

---

## 2. Interactive Auto-Setup (CLI)

The easiest way to set up the MCP server is using our built-in configuration utility. It automatically detects and modifies the settings files for your installed clients.

```bash
# Configure all detected MCP clients in your user directory
npx easyeda-mcp-pro setup all

# Or configure a specific client (e.g. Cursor or Claude Desktop)
npx easyeda-mcp-pro setup cursor
npx easyeda-mcp-pro setup claude
```

### Options:

- `--profile <name>`: Restrict or expand the toolset. Options are `core` (default), `pro`, `full`, or `dev`.
  E.g. `npx easyeda-mcp-pro setup cursor --profile full`

---

## 3. Manual Client Configurations

If you prefer to configure your client manually, append the following configurations to the respective settings files:

### 🟣 Claude Desktop

**Config Path**:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "core"
      }
    }
  }
}
```

### 🔵 Cursor IDE

**Config Path**: Project-specific `.cursor/mcp.json` or global settings.

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

### 🟢 VS Code (GitHub Copilot)

**Config Path**: `%APPDATA%\Code\User\mcp.json` (Windows) or `~/Library/Application Support/Code/User/mcp.json` (macOS).

```json
{
  "servers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

---

## 4. EasyEDA Pro Extension Installation

To bridge the MCP server with the live EasyEDA Pro layout editor:

1. Open your terminal and copy/open the extension directory:
   ```bash
   npx easyeda-mcp-pro extension --open
   ```
   This opens the folder containing `easyeda-bridge-extension.eext`.
2. Open **EasyEDA Pro**.
3. Go to **Settings** → **Extensions** → **Extension Manager**.
4. Click **Import Extension** and select the `easyeda-bridge-extension.eext` file.
5. In the Extension Manager, verify that **Allow External Interaction** is checked for the imported extension.
6. Click **MCP Bridge** → **Connect** in the top menu bar to start the WebSocket connection.

---

## 5. Docker deployment modes

The production image deliberately defaults to `HTTP_HOST=127.0.0.1`. A normal Docker bridge gives
the container its own loopback namespace, so publishing port 3000 alone does **not** make that
default listener reachable from the host.

### Local-only Docker

On Linux, host networking preserves a loopback-only endpoint without changing the safe defaults:

```bash
docker build -t easyeda-mcp-pro:local .
docker run --rm --network host easyeda-mcp-pro:local
curl http://127.0.0.1:3000/healthz
```

This mode is Linux-specific. On Docker Desktop, prefer a native local installation or the
authenticated published-port mode below rather than weakening the bind policy.

### Authenticated published-port Docker

For a reverse proxy, tunnel, or another host process to reach the container, bind the application to
`0.0.0.0` **and** provide complete OAuth/JWKS and explicit origin configuration. The host publication
can still be restricted to loopback:

```bash
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -e HTTP_HOST=0.0.0.0 \
  -e ALLOWED_ORIGINS=https://client.example.com \
  -e OAUTH_ENABLED=true \
  -e OAUTH_ISSUER=https://auth.example.com \
  -e OAUTH_AUDIENCE=https://mcp.example.com/mcp \
  -e OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json \
  easyeda-mcp-pro:local
```

The server fails closed when `HTTP_HOST=0.0.0.0` is used without these controls. CORS, a published
port, or a tunnel is never treated as authentication.
