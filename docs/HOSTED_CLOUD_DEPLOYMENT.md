# Official hosted Cloud — Coolify + Doppler

> **Maturity:** Gated. Follow [Remote Relay status](./REMOTE_RELAY_STATUS.md);
> issue #849 live acceptance and issue #850 rollout gates remain authoritative.
> This is one official hosted service, not a self-hosted customer mode.

## One deployment path

**Protected GitHub main → Coolify Dockerfile build → Doppler runtime values.**
No separate GitHub deployment workflow, hard-coded application credentials,
GitHub Doppler token, second secrets store, or paid service is needed.

- Public website: `https://easyeda-mcp-pro.oaslananka.dev/`
- Authenticated Streamable HTTP MCP: `https://easyeda-mcp-pro.oaslananka.dev/mcp`
- EasyEDA extension outbound secure relay: `wss://easyeda-mcp-pro.oaslananka.dev/remote/relay`
- Plain `http://` should redirect to HTTPS; it is **not** a valid public OAuth issuer.

Coolify owns the HTTPS domain, container, health check, immutable Git commit,
1-CPU/1-GiB resource limits, and persistent `/app/data` volume.
All application runtime settings below resolve from **one Doppler project/config**
through the existing Coolify secret-manager integration. Each Coolify production
variable is <code>&#123;&#123;vault.VARIABLE_NAME&#125;&#125;</code>, not a copied value.

## What to add to Doppler (one time)

Use exactly the existing Doppler project **`easyeda-mcp-pro`** and its
**`main`** config. The owner manages all runtime settings and four
GitHub/Google OAuth credentials only in `main`; no other config is needed.
Coolify's existing EasyEDA secret-manager integration uses a **read-only
service token scoped to `easyeda-mcp-pro/main`**. All 16 production entries
reference that config directly. Do not create another Doppler config or
copy values into GitHub Actions or a second secret store.

| Doppler key                  | Value / requirement                                       |
| ---------------------------- | --------------------------------------------------------- |
| `TRANSPORT`                  | `http`                                                    |
| `HTTP_HOST`                  | `0.0.0.0` (container interface, never public direct port) |
| `MCP_BRIDGE_BACKEND`         | `remote_relay`                                            |
| `OAUTH_ENABLED`              | `true`                                                    |
| `CLOUD_HOSTED_ENABLED`       | `true` **only at approved deployment**                    |
| `CLOUD_HOSTED_ORIGIN`        | `https://easyeda-mcp-pro.oaslananka.dev`                  |
| `ALLOWED_ORIGINS`            | `https://easyeda-mcp-pro.oaslananka.dev` (no wildcard)    |
| `OAUTH_ISSUER`               | `https://easyeda-mcp-pro.oaslananka.dev/api/auth`         |
| `OAUTH_AUDIENCE`             | `https://easyeda-mcp-pro.oaslananka.dev/mcp`              |
| `OAUTH_JWKS_URI`             | `https://easyeda-mcp-pro.oaslananka.dev/api/auth/jwks`    |
| `DATA_DIR`                   | `/app/data` (dedicated persistent Coolify volume)         |
| `CLOUD_AUTH_SECRET`          | Unique random secret, **32 characters minimum**           |
| `CLOUD_GITHUB_CLIENT_ID`     | GitHub OAuth application's client ID                      |
| `CLOUD_GITHUB_CLIENT_SECRET` | GitHub OAuth application's private secret                 |
| `CLOUD_GOOGLE_CLIENT_ID`     | Google OAuth web client's client ID                       |
| `CLOUD_GOOGLE_CLIENT_SECRET` | Google OAuth web client's private secret                  |

Do **not** paste OAuth secrets into issues, code, logs or a GitHub Actions
secret. Coolify resolves <code>&#123;&#123;vault.KEY&#125;&#125;</code> directly at deployment/restart;
updating Doppler alone does **not** hot-reload a running container.

Register these exact redirect URIs with the two identity providers:

- GitHub: `https://easyeda-mcp-pro.oaslananka.dev/api/auth/callback/github`
- Google: `https://easyeda-mcp-pro.oaslananka.dev/api/auth/callback/google`

GitHub and Google sign-in credentials are **not** MCP client OAuth tokens.
MCP clients use this service's standard OAuth metadata/authorization flow.

## Deploy once the live gates pass

1. Confirm Cloudflare's **authoritative nameservers** return a public DNS
   answer for the hostname and HTTPS/TLS reaches the correct Coolify proxy.
   Merely seeing a record in a dashboard does not prove propagation.
2. In Coolify, refresh the linked Doppler key list. Ensure all 16 variables
   are available through the **correct** service token/config and all production
   env entries reference <code>&#123;&#123;vault.KEY&#125;&#125;</code>. Missing secret keys must fail the
   deploy instead of falling back to hard-coded values.
3. After issue #849 live user acceptance, merge the reviewed change with
   all required checks. Pin Coolify's Git commit to that **exact accepted
   main SHA**. Keep automatic deployments and preview deployments off
   until this gate is satisfied.
4. Choose **Deploy once in Coolify**. Its Dockerfile build creates the
   `/app/data` mount location writable by the non-root `node` user. The named volume preserves
   the Better Auth SQLite database and owner pairing state across replacements.
5. Require a healthy `GET /healthz` on container port 3000, then verify
   public HTTPS, GitHub/Google callback, OAuth discovery, authenticated
   `/mcp`, WSS upgrade and the paired **real EasyEDA** extension read path.
   Do not expose or claim production until all acceptance gates pass.
6. For a failed deploy, keep the previous healthy revision, inspect
   **redacted** logs/health check and roll back to the previous verified
   immutable source SHA. Restart/redeploy to load later Doppler changes.

Local MCP remains the default and requires neither Cloud nor a login.
