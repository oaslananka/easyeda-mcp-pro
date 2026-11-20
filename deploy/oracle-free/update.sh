#!/usr/bin/env bash
# In-place Hosted Cloud update on an existing Docker Compose VPS.
# Doppler injects secrets into the child process; none are written to disk.
set -Eeuo pipefail
umask 077

usage() {
  echo "Usage: $0 <existing-deploy-dir> <ghcr.io/oaslananka/easyeda-mcp-pro@sha256:64-hex-digest>"
}

if [[ "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ $# -ne 2 ]]; then usage >&2; exit 2; fi

deploy_dir="$1"
image="$2"
if [[ ! "$image" =~ ^ghcr\.io/oaslananka/easyeda-mcp-pro@sha256:[0-9a-f]{64}$ ]]; then
  echo "Provide an immutable EasyEDA MCP Pro GHCR digest, not a moving tag." >&2
  exit 2
fi
if [[ ! -d "$deploy_dir" ]]; then
  echo "The existing deployment directory does not exist." >&2
  exit 2
fi
cd "$deploy_dir"
for program in sudo docker doppler python3 curl flock; do
  command -v "$program" >/dev/null || { echo "Missing dependency: $program" >&2; exit 2; }
done
exec 9> .easyeda-cloud-update.lock
flock -n 9 || { echo "Another Cloud update is already running." >&2; exit 2; }
sudo -n test -r .env
sudo -n test -r compose.yaml

compose() {
  doppler run -p easyeda-mcp-pro -c main --no-fallback -- \
    sudo -n -E docker compose --env-file .env "$@"
}

current_pin="$(sudo -n awk -F= '$1 == "EASYEDA_IMAGE" {print substr($0, index($0, "=") + 1)}' .env)"
if [[ -z "$current_pin" ]]; then
  echo "Existing .env must declare EASYEDA_IMAGE." >&2
  exit 2
fi
mapfile -t writers < <(sudo -n docker ps --filter volume=easyeda-cloud_cloud-data --format '{{.Names}}')
if [[ ${#writers[@]} -ne 1 || "${writers[0]}" != "easyeda-cloud-cloud-1" ]]; then
  echo "Expected precisely one existing Cloud SQLite writer; refusing update." >&2
  exit 2
fi

target_id="$(sudo -n docker image inspect "$image" --format '{{.Id}}')"
running_id="$(sudo -n docker inspect easyeda-cloud-cloud-1 --format '{{.Image}}')"
if [[ "$current_pin" == "$image" && "$running_id" == "$target_id" ]]; then
  compose config --quiet
  echo "Already running the requested immutable image; nothing changed."
  exit 0
fi
if [[ "$current_pin" == "$image" && "$running_id" != "$target_id" ]]; then
  echo "Deployment pin and running image disagree; investigate before retry." >&2
  exit 2
fi

# Fail before writing anything if the pinned candidate cannot resolve Doppler
# settings and the existing Compose schema. Only config --quiet is used.
EASYEDA_IMAGE="$image" compose config --quiet

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
env_backup=".env.pre-upgrade-${stamp}"
sudo -n cp -p .env "$env_backup"
sudo -n python3 - "$PWD" "$stamp" <<'PY'
from pathlib import Path
import os
import sqlite3
import subprocess
import sys

os.umask(0o077)
root = Path(sys.argv[1])
stamp = sys.argv[2]
volume = subprocess.check_output(
    ["docker", "volume", "inspect", "easyeda-cloud_cloud-data", "--format", "{{.Mountpoint}}"],
    text=True,
).strip()
source = Path(volume) / "hosted-cloud.sqlite"
assert source.is_file(), "Hosted Cloud SQLite file is missing"
backup_dir = root / "backups"
backup_dir.mkdir(mode=0o700, exist_ok=True)
target = backup_dir / f"hosted-cloud-pre-upgrade-{stamp}.sqlite"
assert not target.exists(), "Backup name conflict"
with sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=10) as live:
    with sqlite3.connect(target, timeout=10) as copy:
        live.backup(copy)
with sqlite3.connect(f"file:{target}?mode=ro", uri=True) as checked:
    assert checked.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
print("Consistent SQLite backup created and independently integrity-checked.")
PY

# The persistent .env contains only image/origin/port settings, never secrets.
sudo -n python3 - "$PWD/.env" "$current_pin" "$image" <<'PY'
from pathlib import Path
import os
import sys
import tempfile

path = Path(sys.argv[1])
old, new = sys.argv[2:]
content = path.read_text()
old_line = "EASYEDA_IMAGE=" + old
assert content.splitlines().count(old_line) == 1, "Image pin changed concurrently"
updated = content.replace(old_line, "EASYEDA_IMAGE=" + new, 1)
with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as temp:
    os.fchmod(temp.fileno(), 0o600)
    temp.write(updated)
    name = temp.name
os.replace(name, path)
PY

rollback() {
  trap - ERR
  echo "Upgrade failed; restoring previous image pin and attempting service rollback." >&2
  sudo -n cp -p "$env_backup" .env
  if ! compose up -d --no-build --wait; then
    echo "Rollback failed; use the verified SQLite backup and previous image for recovery." >&2
  fi
  exit 1
}
trap rollback ERR
compose up -d --no-build --wait
new_id="$(sudo -n docker inspect easyeda-cloud-cloud-1 --format '{{.Image}}')"
[[ "$new_id" == "$target_id" ]]
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:13000/healthz > /dev/null
mapfile -t writers < <(sudo -n docker ps --filter volume=easyeda-cloud_cloud-data --format '{{.Names}}')
[[ ${#writers[@]} -eq 1 && "${writers[0]}" == "easyeda-cloud-cloud-1" ]]
trap - ERR
echo "In-place update successful; immutable image verified, one SQLite writer, local health OK."
echo "Next: verify public OAuth, authenticated workspace and editor reconnection."
