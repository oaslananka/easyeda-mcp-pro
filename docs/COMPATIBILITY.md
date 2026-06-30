# Compatibility Matrix

This document lists the tested and supported versions, environments, and clients for `easyeda-mcp-pro`.

---

## 1. Runtime & Environment

| Environment | Supported Versions | Tested Status | Notes                                             |
| :---------- | :----------------- | :------------ | :------------------------------------------------ |
| **Node.js** | `>= 24 < 27`       | **Verified**  | Uses native ESModules features and `node:sqlite`. |
| **pnpm**    | `>= 11`            | **Verified**  | Standard package manager for workspace builds.    |
| **npm**     | `*`                | **Verified**  | Supported via `npx` execution.                    |
| **Docker**  | `v20.x` or newer   | **Verified**  | Fully containerized execution using alpine/node.  |

---

## 2. EasyEDA Pro Versions

| EasyEDA Pro Version         | Tested Status        | Notes                                                                                                               |
| :-------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------ |
| **v3.2.x** (Desktop / Web)  | **Supported**        | Requires **Allow External Interaction**. v3.2.148 needs the bridge open-callback fallback introduced for issue #47. |
| **v2.2.x** (Desktop / Web)  | **Verified**         | Primary development target. Full compatibility.                                                                     |
| **v2.1.x**                  | **Needs Validation** | Mostly compatible, but some schematic APIs may be missing.                                                          |
| **v2.0.x**                  | **Needs Validation** | Underlying extension APIs might not expose required methods.                                                        |
| **v1.x** (Standard Edition) | **Unsupported**      | Standard edition does not support the Pro extension platform.                                                       |

---

## 3. MCP Clients

| Client                   | Configuration | Tested Status | Notes                                       |
| :----------------------- | :------------ | :------------ | :------------------------------------------ |
| **Claude Desktop**       | Stdio         | **Verified**  | Recommended for full layout prompts.        |
| **Cursor IDE**           | Stdio         | **Verified**  | Excellent for coding with live PCB context. |
| **VS Code Copilot**      | Stdio         | **Verified**  | Configured in users settings.               |
| **Windsurf**             | Stdio         | **Verified**  | Excellent transport support.                |
| **Cline**                | Stdio         | **Verified**  | Full auto-approve compatible.               |
| **Gemini / Antigravity** | Stdio         | **Verified**  | Full tool execution support.                |
| **Zed Editor**           | Stdio         | **Verified**  | Fully integrated.                           |

---

## 4. Operating Systems

| OS                                | Supported    | Notes                           |
| :-------------------------------- | :----------- | :------------------------------ |
| **Windows 10/11**                 | **Verified** | Tested with PowerShell and CMD. |
| **macOS** (Intel / Apple Silicon) | **Verified** | Tested with zsh.                |
| **Linux** (Ubuntu / Fedora)       | **Verified** | Tested with bash.               |

---

## 5. Supplier API Integrations

| Supplier    | API Protocol   | Auth Type          | Sourcing Tested | Ordering Tested       |
| :---------- | :------------- | :----------------- | :-------------- | :-------------------- |
| **LCSC**    | HTTPS / Public | Public Search      | **Verified**    | N/A                   |
| **JLCPCB**  | HTTPS / REST   | Client ID & Secret | **Verified**    | **Approved API only** |
| **Mouser**  | HTTPS / REST   | API Key            | **Verified**    | N/A                   |
| **DigiKey** | HTTPS / OAuth2 | OAuth2 Credentials | **Verified**    | N/A                   |
