# Official hosted Cloud — Coolify + Doppler

> **Maturity:** Gated. Follow [Remote Relay status](./REMOTE_RELAY_STATUS.md);
> issue #849 live acceptance and issue #850 rollout gates remain authoritative.
> An Oracle Always Free Compose candidate is under validation in the repository
> root at deploy/oracle-free/. It does not change the current Coolify deployment
> contract or production rollout HOLD.
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

## Coolify build-secret boundary (required)

**Doppler integration alone does not keep secrets out of a Docker image build.**
Coolify can mark runtime variables as build-time and forward their values
as Docker build arguments; this was observed in the 2026-11-15 owner-only pilot.
Never treat a healthy image or redacted application logs as evidence that
its build history is safe.

Before any Hosted Cloud build or public acceptance:

1. Mark **every Hosted Cloud environment variable** as **runtime-only**
   (`is_runtime=true`, `is_buildtime=false`) in **both normal and preview**
   Coolify variable sets. The Dockerfile and build scripts do not consume
   any of these settings during the build. In particular, never expose
   `CLOUD_AUTH_SECRET`, `CLOUD_GITHUB_CLIENT_SECRET`, or
   `CLOUD_GOOGLE_CLIENT_SECRET` to build arguments. Keep the existing
   <code>&#123;&#123;vault.KEY&#125;&#125;</code> Doppler references instead of copying credential values.
2. Enable Coolify's **Use Build Secrets (BuildKit)** and
   **redact all environment values in deployment logs** options. Confirm
   sensitive values are not injected via Docker `--build-arg`.
3. Inspect the exact new image **before** accepting traffic: compare the
   three running-container secret values against Docker's full image
   history and image environment **without printing either values or
   history**. Require each value at runtime and zero matches in the image.
   This checks image metadata, not every intermediate build cache layer.

**If this check fails:** stop the candidate, remove only demonstrably
unreferenced affected application images, assess local build cache and
registry exposure, and rotate the exposed credentials before public release.
Do not prune other projects' images, caches, containers, or volumes.

For a restart or rollback at the **same commit**, first verify that **neither**
Coolify variable set has build-time entries. In the 2026-11-16 owner pilot,
13 otherwise runtime-only values had mistakenly been marked build-time in
each set. Coolify consequently rebuilt an already-cached image, consuming
shared VPS resources. Clearing only those flags allowed the subsequent
same-commit deployment to reuse the existing image, with the persistent
`/app/data` volume unchanged. This avoids unnecessary builds; it does **not**
clear the separate historical OAuth secret exposure/rotation gate below.

### Owner-only preview ingress must preserve Cloud API calls

The 2026-11-15 owner pilot exposed an operational trap: a temporary
Cloudflare Access policy aimed at `/cloud` also intercepted
`/cloud/api/*`. When the browser held a valid **application** login but
no separate **Cloudflare Access** login, the API responded with a
cross-origin redirect to Cloudflare's login page; the dashboard's CSP
blocked that fetch, displaying a misleading **Failed to fetch** error.

Before a bounded preview, either establish and verify the owner's
separate Cloudflare Access session, or use an ingress policy that
protects the full preview's authenticated journey without redirecting
its API calls unexpectedly. The dashboard now distinguishes a genuine
application HTTP 401 from unreachable APIs and additional Access login
requirements. It preserves a usable **Refresh** action after an initial
device-list failure instead of discarding the current signed-in page.
Test the actual browser refresh/recovery and `/cloud/api/extensions` with
the intended owner login, not just `/cloud` and `/healthz`. A successful
application OAuth login is **not** proof that a separate Access gate is
satisfied. Remove all temporary access rules and preview credentials
during cleanup.

### Live build-secret proof and outstanding release risk (2026-11-15)

The bounded owner pilot on exact reviewed PR #1057 head `f1c9b70`
**passed** the checks above: all six OAuth secret environment entries
(regular and preview) are now `is_buildtime=false, is_runtime=true`;
Dockerfile build-argument injection is disabled, BuildKit secrets and
deployment-log redaction are enabled, and an inspected live candidate image
contained **none of the three current OAuth secret values** in its history
or image environment. Runtime credentials were present in the container.
No credential values were printed in the evidence. The app was subsequently
stopped, returned to its former `main` commit pin and remained
auto-deploy-disabled. See [issue #849 evidence](https://github.com/oaslananka/easyeda-mcp-pro/issues/849#issuecomment-6888075039).

**Release gate remains open:** the very first, earlier Coolify build had
embedded OAuth secret values in Docker image history. Removing known
unused images and producing a clean _new_ image does **not** establish
that no earlier build cache, registry or copies remain. Perform an
application-scoped exposure assessment and rotate affected credentials as
appropriate before a public launch; do not silently prune shared builder
cache or claim those earlier values were never exposed.

## What to add to Doppler (one time)

Use exactly the existing Doppler project **`easyeda-mcp-pro`** and its
**`main`** config. The owner manages all runtime settings and four
GitHub/Google OAuth credentials only in `main`; no other config is needed.
Coolify's existing EasyEDA secret-manager integration uses a **read-only
service token scoped to `easyeda-mcp-pro/main`**. All 18 production entries
reference that config directly. Do not create another Doppler config or
copy values into GitHub Actions or a second secret store.

| Doppler key                  | Value / requirement                                        |
| ---------------------------- | ---------------------------------------------------------- |
| `TRANSPORT`                  | `http`                                                     |
| `HTTP_HOST`                  | `0.0.0.0` (container interface, never public direct port)  |
| `MCP_BRIDGE_BACKEND`         | `remote_relay`                                             |
| `OAUTH_ENABLED`              | `true`                                                     |
| `MCP_V2_EXPERIMENTAL`        | `true` (legacy + stateless HTTP on the same URL)           |
| `MCP_APPS_ENABLED`           | `true` (read-only project review; headless tools retained) |
| `CLOUD_HOSTED_ENABLED`       | `true` **only at approved deployment**                     |
| `CLOUD_HOSTED_ORIGIN`        | `https://easyeda-mcp-pro.oaslananka.dev`                   |
| `ALLOWED_ORIGINS`            | `https://easyeda-mcp-pro.oaslananka.dev` (no wildcard)     |
| `OAUTH_ISSUER`               | `https://easyeda-mcp-pro.oaslananka.dev/api/auth`          |
| `OAUTH_AUDIENCE`             | `https://easyeda-mcp-pro.oaslananka.dev/mcp`               |
| `OAUTH_JWKS_URI`             | `https://easyeda-mcp-pro.oaslananka.dev/api/auth/jwks`     |
| `DATA_DIR`                   | `/app/data` (dedicated persistent Coolify volume)          |
| `CLOUD_AUTH_SECRET`          | Unique random secret, **32 characters minimum**            |
| `CLOUD_GITHUB_CLIENT_ID`     | GitHub OAuth application's client ID                       |
| `CLOUD_GITHUB_CLIENT_SECRET` | GitHub OAuth application's private secret                  |
| `CLOUD_GOOGLE_CLIENT_ID`     | Google OAuth web client's client ID                        |
| `CLOUD_GOOGLE_CLIENT_SECRET` | Google OAuth web client's private secret                   |

Do **not** paste OAuth secrets into issues, code, logs or a GitHub Actions
secret. Coolify resolves <code>&#123;&#123;vault.KEY&#125;&#125;</code> directly at deployment/restart;
updating Doppler alone does **not** hot-reload a running container.

Register these exact redirect URIs with the two identity providers:

- GitHub: `https://easyeda-mcp-pro.oaslananka.dev/api/auth/callback/github`
- Google: `https://easyeda-mcp-pro.oaslananka.dev/api/auth/callback/google`

GitHub and Google sign-in credentials are **not** MCP client OAuth tokens.

For hosted AI agents, enable `MCP_V2_EXPERIMENTAL=true` to accept both
MCP `2025-11-25` and `2026-07-28`. This enables neither write permissions
nor bypasses of OAuth/project selection. See
[AI clients and MCPJam acceptance](guide/cloud-ai-connectors.md).

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
   Confirm the [build-secret boundary](#coolify-build-secret-boundary-required) above.
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
2. In Coolify, refresh the linked Doppler key list. Ensure all 18 variables
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
