# Getting Started

Connect your open EasyEDA Pro project to an MCP-compatible assistant. Start locally: **no Cloud account or repository clone is required**.

## Before you begin

- Install **EasyEDA Pro** on your computer.
- Install **Node.js 24.x**, then verify it with `node --version`.
- Have an MCP-capable client such as Claude Desktop, Cursor, VS Code, or another supported client.

**You do not need pnpm, Git, or a source checkout** to use the published `npx` commands below. Contributors building from source should follow [CONTRIBUTING.md](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTING.md) instead; that workflow pins Node.js 24.22.3 and pnpm 11.28.11.

## Connect locally

### 1. Set up your MCP client

Run the interactive setup:

```bash
npx easyeda-mcp-pro init
```

The wizard helps you choose a detected client and a tool profile, writes the client's MCP configuration, and locates the EasyEDA bridge extension. It **does not automatically install the extension inside EasyEDA Pro**.

For a non-interactive setup of all detected clients, use `npx easyeda-mcp-pro setup all` instead.

### 2. Install the bridge in EasyEDA Pro

1. Open **EasyEDA Pro** and select **Advanced > Extensions Manager** (EasyEDA Pro 3.2.209; older builds may put the manager under Settings).
2. Select **Import Extension** and choose `easyeda-bridge-extension.eext`. If you need to locate the bundled file again, run `npx easyeda-mcp-pro extension --open`.
3. Enable **Allow External Interaction** for the extension.
4. **Fully quit and reopen EasyEDA Pro.** Importing or enabling the extension without restarting may leave the previous dispatcher in memory.
5. Open a project and focus the schematic or PCB you want to inspect.
6. Open **MCP Bridge** in EasyEDA and choose the **local MCP** connection. Do not enter the hosted Cloud MCP URL in the extension's custom WebSocket field.

### 3. Start your assistant and check the connection

Restart your MCP client after its configuration changes. With the client connected to the open editor, ask it to check EasyEDA MCP Pro health and list the available projects.

If the connection is not ready, run:

```bash
npx easyeda-mcp-pro --doctor
```

A bridge shown as offline while no MCP client has started the server is informational, not proof of a broken installation. Follow the [troubleshooting guide](./troubleshooting.md) if it stays disconnected after starting the client.

## Make your first useful request

Open a schematic and ask:

> Which components connect to the 3V3 rail? Show the net and pin evidence, and identify what needs a manual datasheet or layout check.

Continue with the [schematic review walkthrough](../examples/schematic-review.md). Read and write permissions depend on your tool profile and selected project. Mutations require explicit confirmation; Cloud adds a separate owner-approval boundary. An automated review does not certify electrical correctness or manufacturing readiness.

## Other connection choices

Local MCP works without Cloud sign-in. Hosted access is a separate opt-in workflow with account sign-in, device pairing and explicit project selection. See [Local and Cloud modes](../REMOTE_MCP_MODES.md).

For advanced source builds, client configuration and troubleshooting, see [Configuration](./configuration.md) and the [Tool Reference](../reference/tools.md).
