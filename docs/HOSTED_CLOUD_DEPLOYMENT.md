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
- OAuth authorization metadata: `https://easyeda-mcp-pro.oaslananka.dev/.well-known/oauth-authorization-server/api/auth` (RFC 8414 issuer-path discovery).
- EasyEDA extension outbound secure relay: `wss://easyeda-mcp-pro.oaslananka.dev/remote/relay`
- Plain `http://` should redirect to HTTPS; it is **not** a valid public OAuth issuer.

Coolify owns the HTTPS domain, container, health check, immutable Git commit,
1-CPU/1-GiB resource limits, and persistent `/app/data` volume.
The container health probe must use **host `127.0.0.1`**, port `3000`,
path `/healthz`, and expect HTTP 200. Alpine BusyBox `wget` can resolve
`localhost` to IPv6 `::1` while this HTTP server listens on IPv4;
that combination fails the Coolify probe even when the app is running.
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

## First activation for owner-only live acceptance

The real GitHub/Google callback, public MCP and WSS checks in #849 cannot
pass while the official service returns 503. This is a **bounded pre-release
acceptance exception**, not general availability, and uses the **same existing**
Coolify application and official domain. No staging service, extra database,
billable provider, auto-deploy or public release is required.

1. Require the exact PR candidate SHA with **all required CI checks passing**.
   Save the current Coolify application branch, pinned commit, ingress policy
   and running status as rollback inputs. Verify the existing read-only Doppler
   integration lists all required production keys and that /app/data is mounted.
   Never copy secret values out of Doppler or log them.
2. Keep **automatic and preview deployments disabled**. For this time-boxed
   acceptance only, manually select the reviewed PR branch and its **exact
   verified commit** in the existing application. The protected main branch
   remains the target for the eventual production deployment.
3. Before starting the app, configure and verify a **temporary owner-only
   ingress policy restricted to this hostname**; do not change policies for
   other applications. Verify it permits the owner's GitHub/Google callback
   navigation. If the identity gate interferes with native WSS or MCP discovery,
   any narrowly scoped path exception must still enforce application-level
   pairing, OAuth, token scopes and selected-project authorization. Do not
   weaken those checks or claim the external-client test passed through an
   intermediary login it cannot use. Without a verifiable access boundary,
   **stop here**.
4. Start **one manual acceptance deployment**. Require healthy /healthz,
   TLS, protected /mcp, negative unauthorized and cross-owner requests,
   both real provider callbacks, and genuine owner-paired EasyEDA WSS with
   selected disposable project/document IDs and a read-only routed MCP call.
   A mocked response or invalid pairing-code rejection alone is insufficient.
   Record exact deployed SHA, observed outcomes and test-only access policy
   without publishing any tokens or raw project payloads.
5. On any failed check, stop the application, restore the prior branch/commit
   and ingress configuration, and keep #850 marked **HOLD**. Never report an
   acceptance activation as a successful production rollout. The first live
   design write remains separately subject to explicit owner approval.
6. Only after #849's real user journey and required approvals pass, mark the
   PR review-ready, merge it with normal required checks, re-pin the accepted
   **protected main SHA**, remove temporary owner-only constraints as
   appropriate, and follow the ordinary deployment steps below. Re-run
   external HTTPS, OAuth, MCP, WSS, revocation and rollback probes.

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
