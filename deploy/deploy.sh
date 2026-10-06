#!/bin/bash
# Keeps the host on the newest commit of main.
#
# Run from cron every few minutes. It fetches main from GitHub with a read-only deploy key and
# does nothing while the deployed commit is the newest one. A deploy backs up the database, the
# running image and the files, builds and starts the new version, checks that it answers and
# reports the right commit on /version, and puts the previous version back if it does not.
#
# GitHub hears about it from the other side: the Deploy workflow (.github/workflows/deploy.yml)
# waits for /version to show the new commit and records the outcome as a GitHub Deployment. So
# nothing here needs GitHub credentials beyond the key.
#
#   deploy.sh            deploy when main has moved
#   deploy.sh --force    deploy the newest main again, also after a failed attempt
#
# Settings come from /etc/tebonsma-api-deploy.env (see deploy.env.example). Needs git, sqlite3,
# flock and docker compose.

set -Eeuo pipefail
# Cron starts with almost no PATH
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ENV_FILE=${ENV_FILE:-/etc/tebonsma-api-deploy.env}
# shellcheck source=deploy.env.example
. "$ENV_FILE"
REPO_URL=${REPO_URL:-git@github.com:TEBONSMA/tebonsma-api.git}
DEPLOY_KEY=${DEPLOY_KEY:-/etc/tebonsma-api-deploy/id_ed25519}
BRANCH=${BRANCH:-main}
APP_DIR=${APP_DIR:-/opt/tebonsma-api}
CONTAINER=${CONTAINER:-tebonsma-api}
IMAGE=${IMAGE:-tebonsma-api-tebonsma-api}
DB_FILE=${DB_FILE:-/var/lib/docker/volumes/tebonsma-api_data/_data/tebonsma.db}
BACKUP_DIR=${BACKUP_DIR:-/opt/backups/tebonsma-api}
STATE_DIR=${STATE_DIR:-/var/lib/tebonsma-api-deploy}
KEEP_BACKUP_DAYS=${KEEP_BACKUP_DAYS:-14}
# The folders the repository owns in APP_DIR; everything else there (.env, backups) is left alone
REPO_DIRS=(src dev test deploy)
MIRROR=$STATE_DIR/repo.git

[[ -r "$DEPLOY_KEY" ]] || { echo "deploy key $DEPLOY_KEY is missing" >&2; exit 1; }
export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Puts the version from before this attempt back, and leaves a mark so the same commit is not
# tried again by itself
fail() {
  trap - ERR
  log "FAILED: $*"
  if [[ -n "${STAMP:-}" ]]; then
    log "rolling back to the previous version"
    tar -xzf "$BACKUP_DIR/src-$STAMP.tgz" -C "$(dirname "$APP_DIR")" || log "could not restore the files"
    docker tag "$IMAGE:rollback" "$IMAGE:latest" || log "could not restore the image"
    (cd "$APP_DIR" && docker compose up -d --no-build) || log "could not start the previous version"
  fi
  echo "$SHA" >"$STATE_DIR/failed"
  exit 1
}
on_error() { fail "error on line $1"; }

install -d -m 700 "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "another deploy is running"; exit 0; }

# A bare copy of the repository, brought up to date on every run
[[ -d "$MIRROR" ]] || git clone --quiet --bare "$REPO_URL" "$MIRROR"
git -C "$MIRROR" fetch --quiet origin "+refs/heads/$BRANCH:refs/heads/$BRANCH"
SHA=$(git -C "$MIRROR" rev-parse "refs/heads/$BRANCH")
DEPLOYED=$(cat "$STATE_DIR/deployed" 2>/dev/null || true)
FAILED=$(cat "$STATE_DIR/failed" 2>/dev/null || true)
if [[ "${1:-}" != --force ]]; then
  [[ "$SHA" != "$DEPLOYED" ]] || exit 0
  [[ "$SHA" != "$FAILED" ]] || exit 0
fi
log "deploying ${SHA:0:7} (deployed: ${DEPLOYED:0:7})"
trap 'on_error $LINENO' ERR

WORK=$(mktemp -d /tmp/tebonsma-api-deploy.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
git -C "$MIRROR" archive --format=tar "$SHA" | tar -x -C "$WORK"

STAMP=$(date +%Y-%m-%d-%H%M%S)
sqlite3 "$DB_FILE" ".backup $BACKUP_DIR/db-$STAMP.db"
tar -czf "$BACKUP_DIR/src-$STAMP.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
docker tag "$IMAGE:latest" "$IMAGE:rollback"
find "$BACKUP_DIR" -type f -mtime +"$KEEP_BACKUP_DAYS" -delete

# Folders are replaced whole, so files removed upstream disappear here too
for dir in "${REPO_DIRS[@]}"; do rm -rf "${APP_DIR:?}/$dir"; done
cp -r "$WORK/." "$APP_DIR/"
# What the API reports on /version (docker-compose.yaml passes this file into the container)
printf 'COMMIT_SHA=%s\nDEPLOYED_AT=%s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$APP_DIR/version.env"
(cd "$APP_DIR" && docker compose up -d --build)

health=starting
for _ in $(seq 1 45); do
  health=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [[ "$health" == healthy ]] && break
  sleep 2
done
[[ "$health" == healthy ]] || fail "the container is $health after 90 seconds"

# The new version must report its commit, and answer like the old one: open endpoints answer,
# member endpoints ask for a login
docker exec -e "EXPECTED_SHA=$SHA" "$CONTAINER" node --input-type=module -e '
const api = "http://127.0.0.1:8080"
let wrong = 0
const version = await fetch(api + "/version").then(res => res.json(), () => ({}))
if (version.commit !== process.env.EXPECTED_SHA) { wrong++; console.log(`/version reports ${version.commit}, expected ${process.env.EXPECTED_SHA}`) }
const checks = [["/health", 200], ["/feed/posts", 200], ["/events", 200], ["/calendar.ics", 200], ["/me", 401], ["/mail/folders", 401], ["/bet/me", 401]]
for (const [path, expected] of checks) {
  const status = await fetch(api + path).then(res => res.status, () => 0)
  if (status !== expected) { wrong++; console.log(`${path} answered ${status}, expected ${expected}`) }
}
process.exit(wrong ? 1 : 0)
' || fail "the new version does not answer as expected"
sqlite3 "$DB_FILE" 'PRAGMA integrity_check;' | grep -qx ok || fail "the database failed its integrity check"

echo "$SHA" >"$STATE_DIR/deployed"
rm -f "$STATE_DIR/failed"
log "deployed ${SHA:0:7}"
