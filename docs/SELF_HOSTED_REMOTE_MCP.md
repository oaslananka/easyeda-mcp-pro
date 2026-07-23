# Self-hosted Remote MCP setup

Self-hosted Remote MCP lets an operator expose EasyEDA MCP Pro through their own domain, tunnel,
VPS, or reverse proxy. This mode is for power users and private deployments that need a public MCP
endpoint without using the hosted gateway.

**Current status:** two distinct self-hosted paths exist. The established path tunnels the
OAuth-protected HTTP transport from the same always-on machine that runs EasyEDA Pro and uses
the local loopback bridge. The experimental relay path selects
`MCP_BRIDGE_BACKEND=remote_relay`, pairs an outbound extension session, and does not start a
local bridge listener. The relay path is covered by real Streamable HTTP MCP tests with a fake
extension, including approval-gated writes, but still requires live EasyEDA dogfood before Beta.

## Architecture

```text
Remote MCP client
  ↓
https://mcp.user-domain.example/mcp
  ↓
User-managed tunnel or reverse proxy
  ↓
EasyEDA MCP server
  ↓
EasyEDA bridge extension
  ↓
Open EasyEDA Web project
```

## Minimum safe configuration

Use the implemented HTTP/OAuth settings below for the current server runtime:

```dotenv
TRANSPORT=http
HTTP_HOST=127.0.0.1
HTTP_PORT=3000
ALLOWED_ORIGINS=https://mcp.user-domain.example
OAUTH_ENABLED=true
OAUTH_ISSUER=https://auth.example.com
OAUTH_AUDIENCE=https://mcp.user-domain.example/mcp
OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
OAUTH_REQUIRED_SCOPES=easyeda.read
```

The server exposes protected-resource metadata for remote clients at:

```text
https://mcp.user-domain.example/.well-known/oauth-protected-resource/mcp
```

The local server should bind to localhost behind the tunnel or reverse proxy. Every non-loopback
listener requires OAuth/JWKS authentication and an explicit non-wildcard origin allowlist regardless
of `NODE_ENV`; a tunnel or CORS policy alone is not an authentication boundary.

## Experimental relay configuration

Use the explicit backend selector when testing the paired outbound relay path:

```dotenv
TRANSPORT=http
MCP_BRIDGE_BACKEND=remote_relay
MCP_REMOTE_SESSION_ID=
OAUTH_ENABLED=true
```

`MCP_REMOTE_SESSION_ID` may identify one fixed session, or the MCP request can provide
`remoteSessionId`. Pairing is mandatory before routing. Risky MCP tools automatically request
approval in the paired EasyEDA extension; the MCP client then retries the same call with the
returned `remoteApprovalId`. Do not advertise this path as Beta until live EasyEDA relay
validation and the remaining release-readiness gates are complete.

## Cloudflare Tunnel example

```yaml
tunnel: easyeda-mcp
credentials-file: /home/user/.cloudflared/easyeda-mcp.json

ingress:
  - hostname: mcp.user-domain.example
    service: http://localhost:3000
  - service: http_status:404
```

Example commands:

```bash
cloudflared tunnel route dns easyeda-mcp mcp.user-domain.example
cloudflared tunnel run easyeda-mcp
```

## Operator checklist

Before exposing a self-hosted endpoint:

- [ ] TLS is enabled at the public endpoint.
- [ ] Auth is enabled.
- [ ] Pairing is required before any relay tool routing.
- [ ] The approval dialog, rejected decision, timeout, changed-input rejection, and replay
      rejection have been verified before relay write/export is advertised.
- [ ] The local MCP server is not anonymously exposed.
- [ ] The extension shows the active project before approving changes.
- [ ] Logs are redacted and stored safely.
- [ ] The operator knows how to revoke tokens and stop the tunnel.

## Troubleshooting

| Symptom                      | Likely cause                          | Resolution                                 |
| ---------------------------- | ------------------------------------- | ------------------------------------------ |
| Remote client cannot connect | Tunnel DNS or service target is wrong | Verify public hostname and local port.     |
| Tools return unpaired        | Extension has not completed pairing   | Re-run pairing flow.                       |
| Tools return disconnected    | Extension relay is not active         | Open EasyEDA and enable Remote Relay Mode. |
| Write action is rejected     | Approval missing or timed out         | Approve the exact action in the extension. |

## Security warning

A tunnel only makes a local service reachable. It does not provide authorization by itself.
Production self-hosted endpoints must use auth, pairing, approval policy, and safe logging.
