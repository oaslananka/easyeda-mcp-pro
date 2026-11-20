# Oracle Always Free Cloud candidate

This is an alternative **single-VM** deployment for the first-party EasyEDA
Cloud. It does not provision new infrastructure, change DNS, or enable public
access. [Hosted user acceptance #849](https://github.com/oaslananka/easyeda-mcp-pro/issues/849)
and [Cloud rollout #850](https://github.com/oaslananka/easyeda-mcp-pro/issues/850)
remain the production gates.

## Why Compose

The existing Oracle Always Free machine has Docker Compose. The owner-restricted
pilot uses an externally built image whose exact reviewed source SHA and Docker
image ID were verified on both hosts; **do not build on a 1 GB VM**.
A public Hosted Cloud release is still subject to the rollout acceptance gates.

The Compose manifest limits memory, CPU, processes, logs and port exposure,
while keeping the SQLite database in a persistent Docker named volume.
The exact `https://pro.easyeda.com` Origin is included alongside the canonical
Cloud origin to support the real browser editor's WebSocket pairing. Do not use
`ALLOWED_ORIGINS=*`: unauthorized relay upgrades must remain rejected, and
the existing one-time pairing and owner grants still apply.
The owner pilot uses a bounded 8 MiB relay frame cap (binary results retain
a 60% margin) so small native zipped Gerber exports fit; exports that exceed
this cap must still fail closed. This does not relax OAuth, pairing or
per-action export approval.
Leave the existing reverse proxy and unrelated applications untouched.

## Prepare and start

1. Copy the Compose manifest and non-secret .env.example into a private
   deployment directory. Copy .env.example to .env, then chmod 600 .env.
2. Verify the **existing** Doppler project/config using a previously
   authorized operator machine (MSI or VPS). This command lists **names only**,
   never secret values:

       doppler secrets --only-names --project easyeda-mcp-pro --config main

   Confirm CLOUD_AUTH_SECRET, CLOUD_GITHUB_CLIENT_ID,
   CLOUD_GITHUB_CLIENT_SECRET, CLOUD_GOOGLE_CLIENT_ID and
   CLOUD_GOOGLE_CLIENT_SECRET are present. This was verified on both
   authenticated operator machines on 2026-11-14. The separate Ops Doppler
   reader may return 404 because it has different account permissions;
   that alone does not mean the secrets are missing.

   For an actual deployment, inject the existing values with a scoped
   read-only Doppler **service** credential. Do not copy an operator's
   personal CLI authentication to the Oracle VM, invent replacement OAuth
   credentials, or put secret values in Git, issues, logs, Actions, or the
   non-secret .env file. An authorized Doppler CLI session can inject
   runtime variables via `doppler run`. The owner-restricted Oracle pilot
   uses a config-scoped read-only service token rather than operator login.

3. With secrets injected into the process environment, run:

       docker compose --env-file .env config --quiet
       # Verify an existing reviewed image (or pull only if published).
       docker image inspect "$(docker compose --env-file .env config --images)"
       docker compose --env-file .env up -d --no-build --wait
       docker compose --env-file .env ps
       curl -fsS http://127.0.0.1:13000/healthz

4. Check unauthenticated MCP rejects missing bearer tokens. Confirm real
   OAuth callback, paired EasyEDA WSS, read-only MCP calls and revocation
   with genuine users before changing the public DNS/ingress. Both social
   providers must retain their exact registered callback origin.

## Repeatable in-place VPS upgrades

Once a stable release image has passed publication checks, use the existing
single-VM deployment and its **already-authorized** Doppler access. The provider
of the Ubuntu VPS does not affect this command. No new VM, staging instance,
database, CI runner, or secret store is required.

First resolve the immutable Linux image digest from the published release
and pull it **on the deployment VPS** (building on a 1 GiB machine is not
supported):

```bash
sudo docker pull ghcr.io/oaslananka/easyeda-mcp-pro@sha256:<verified-64-hex-digest>
```

Then invoke the repository's update helper from the operator's working copy.
The second argument must be the same immutable GHCR digest:

```bash
bash deploy/oracle-free/update.sh \
  /home/ubuntu/services/easyeda-cloud \
  ghcr.io/oaslananka/easyeda-mcp-pro@sha256:<verified-64-hex-digest>
```

The helper fails closed if the runtime secret-manager configuration is not
available or if another SQLite writer is detected. It validates Compose
without printing secrets, creates an independent consistent SQLite online
backup, retains the original non-secret image pin, and replaces the **same**
Compose container with no second database writer. It verifies exact running
image identity and local health, and attempts to restore the previous image
on failure. SQLite backups are retained for explicit recovery; the helper
does **not** blindly overwrite live data or claim schema rollback safety.

The current owner-operated VPS has a working authenticated Doppler CLI session.
For sustainable unattended operation, provision a **project/config-scoped
read-only Doppler service identity** through an authorized local provider
procedure. Never write credentials into `.env`, the repository, GitHub
Actions, copied shell commands, or logs. A CLI login by itself must not be
mistaken for that durable scoped service identity. No token transfer or
provider-specific account changes are part of the update helper.

After an update, separately verify public OAuth discovery, unauthenticated
401 responses, authenticated sign-in, editor reconnect/selection, real native
MCP operations and any outstanding release acceptance. A healthy container
does not close the Cloud real-user acceptance issue.

## Persistence and rollback

The named Docker volume cloud-data contains hosted-cloud.sqlite and other
runtime state. Preserve it across updates and reboots. **Never run
docker compose down -v or delete this volume.**

- Stop without data loss: docker compose --env-file .env stop.
- Roll back: change EASYEDA_IMAGE to a previously verified immutable digest;
  run docker compose up -d --wait while preserving the same volume.
- For a real data migration quiesce the previous SQLite writer, make a
  consistent SQLite online backup (including WAL activity), verify its
  restored contents, and switch public routing only after live acceptance.
  Do not permit two independent writers to the same logical state.
- Docker's restart policy restores the existing container after reboot,
  without an active Doppler CLI session. Updates require a new authorized
  secrets injection. Never perform broad Docker prunes.
- Resource limits are conservative; 1 GB RAM is **not** a production capacity
  guarantee. Measure CPU/RAM, WebSocket longevity and restart recovery.

Since 2026-11-16 the owner-restricted Cloud pilot has been served from this
Oracle VM via the existing Cloudflare hostname. Its previous VPS instance
is stopped with the original data volume and image retained for rollback.
A live 33-component PCB read and owner revocation from the browser editor
were verified on 2026-11-16. Native desktop notice/no-retry, independent-user
isolation, and authorized WRITE/export persistence remain public-release gates.
