# Self-hosted Remote MCP setup

Self-hosted Remote MCP lets an operator expose EasyEDA MCP Pro through their own domain, tunnel, VPS, or reverse proxy. This mode is for power users and private deployments that need a public MCP endpoint without using the hosted gateway.

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

```env
TRANSPORT=http
HTTP_HOST=127.0.0.1
HTTP_PORT=3000
PUBLIC_BASE_URL=https://mcp.user-domain.example
AUTH_REQUIRED=true
PAIRING_REQUIRED=true
REMOTE_MODE=self_hosted
REQUIRE_APPROVAL_FOR_WRITE=true
REQUIRE_APPROVAL_FOR_EXPORT=true
```

The local server should bind to localhost behind the tunnel or reverse proxy. Do not bind to all interfaces unless the host firewall, TLS, auth, and origin policy are explicitly configured.

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
- [ ] Pairing is required.
- [ ] Write/export approvals are enabled.
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

A tunnel only makes a local service reachable. It does not provide authorization by itself. Production self-hosted endpoints must use auth, pairing, approval policy, and safe logging.
