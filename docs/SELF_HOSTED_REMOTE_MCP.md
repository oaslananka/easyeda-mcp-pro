# Self-hosted Remote MCP setup

Self-hosted Remote MCP lets an operator expose EasyEDA MCP Pro through their own domain, tunnel,
VPS, or reverse proxy. This mode is for power users and private deployments that need a public MCP
endpoint without using the hosted gateway.

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

```env
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

The local server should bind to localhost behind the tunnel or reverse proxy. Do not bind to all
interfaces unless the host firewall, TLS, auth, and origin policy are explicitly configured.

## Planned relay controls

The following settings are remote-relay design targets and should remain documented as planned until
the relay runtime is implemented:

```env
REMOTE_MODE=self_hosted
PAIRING_REQUIRED=true
REQUIRE_APPROVAL_FOR_WRITE=true
REQUIRE_APPROVAL_FOR_EXPORT=true
```

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
- [ ] Pairing is required before write/export once relay mode is enabled.
- [ ] Write/export approvals are enabled before relay write/export is advertised.
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
