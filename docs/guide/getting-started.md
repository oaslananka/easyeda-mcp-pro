# Getting Started

`easyeda-mcp-pro` is a Model Context Protocol (MCP) server that connects your AI assistant (like Claude, Cursor, VS Code Copilot, or Antigravity) with your **EasyEDA Pro** desktop environment. It allows AI models to safely read, inspect, check rules, and write schematic/PCB designs.

---

## Prerequisites

- **Node.js**: 24.x, with `24.18.0` pinned for repository automation
- **pnpm**: exactly `11.5.1` when building from source

```bash
nvm install 24.18.0
nvm use 24.18.0
corepack enable
corepack prepare pnpm@11.5.1 --activate
node scripts/check-runtime.mjs --require-pnpm
```

- **EasyEDA Pro**: Installed on your system

---

## Quick Setup (Recommended)

The easiest way to install and configure everything is to run the interactive setup wizard:

### 1. Run the Setup Wizard

```bash
npx easyeda-mcp-pro init
```

This wizard will guide you through:

1. **Selecting your AI Client**: It automatically detects installed IDEs/clients (Claude Desktop, Cursor, VS Code, Windsurf, Cline, Gemini/Antigravity, Zed, Amazon Q, Continue) and inserts the correct MCP config.
2. **Selecting your Tool Profile**: Choose between `core` (read/inspect), `pro` (manufacturing exports), `full` (full control API), or `dev` (diagnostics).
3. **Importing the Extension**: It will help you locate the `.eext` bridge extension bundle and open the folder in your file manager.

### 2. Import the Extension in EasyEDA Pro

To allow the MCP server to communicate with EasyEDA Pro, you must import the bridge extension:

1. Open **EasyEDA Pro**.
2. Go to **Settings** → **Extensions** → **Extension Manager...**.
3. Click **Import Extension** and select the `easyeda-bridge-extension.eext` package (which was shown or copied during the `init` command).
4. Ensure **Allow External Interaction** is checked/enabled for the extension in the manager.
5. In the top header menu, click **MCP Bridge** → **Connect**.

### 3. Restart Your Client

After configuration is written, restart your AI IDE or client (e.g., Claude Desktop, Cursor, VS Code) to start the MCP server.

---

## Manual Client Setup

If you prefer to configure your client manually, you can run the non-interactive setup:

```bash
# Configure all detected clients automatically
npx easyeda-mcp-pro setup all

# Or configure a specific client (e.g., Cursor)
npx easyeda-mcp-pro setup cursor --profile pro
```

To copy the extension file to a custom folder:

```bash
npx easyeda-mcp-pro extension --copy /path/to/destination
```
