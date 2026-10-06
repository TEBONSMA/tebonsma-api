#!/bin/bash
# Keeps the host on the newest commit of main, and tells GitHub what is deployed.
#
# Run from cron every few minutes. It does nothing while the deployed commit is the newest one.
# A deploy backs up the database, the running image and the files, builds and starts the new
# version, checks that it answers, and puts the previous version back if it does not. Every
# attempt is recorded as a GitHub Deployment on the "production" environment, so the repository
# shows which commit is live.
#
#   deploy.sh            deploy when main has moved
#   deploy.sh --force    deploy the newest main again, also after a failed attempt
#
# Settings come from /etc/tebonsma-api-deploy.env (see deploy.env.example). Needs curl, python3,
# sqlite3, flock and docker compose.

set -Eeuo pipefail
# Cron starts with almost no PATH
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ENV_FILE=${ENV_FILE:-/etc/tebonsma-api-deploy.env}
# shellcheck source=deploy.env.example
. "$ENV_FILE"
: "${GITHUB_TOKEN:?is not set in $ENV_FILE}"
REPO=${REPO:-TEBONSMA/tebonsma-api}
BRANCH=${BRANCH:-main}
APP_DIR=${APP_DIR:-/opt/tebonsma-api}
CONTAINER=${CONTAINER:-tebonsma-api}
IMAGE=${IMAGE:-tebonsma-api-tebonsma-api}
DB_FILE=${DB_FILE:-/var/lib/docker/volumes/tebonsma-api_data/_data/tebonsma.db}
BACKUP_DIR=${BACKUP_DIR:-/opt/backups/tebonsma-api}
STATE_DIR=${STATE_DIR:-/var/lib/tebonsma-api-deploy}
ENVIRONMENT=${ENVIRONMENT:-production}
ENVIRONMENT_URL=${ENVIRONMENT_URL:-https://api.tebonsma.no}
KEEP_BACKUP_DAYS=${KEEP_BACKUP_DAYS:-14}
# The folders the repository owns in APP_DIR; everything else there (.env, backups) is left alone
REPO_DIRS=(src dev test deploy)

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# curl with the token, read from a file descriptor so it never shows in the process list
gh() {
  curl -sS --fail-with-body -K <(printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n' "$GITHUB_TOKEN") "$@"
}
# A field from JSON on stdin, by path: json commit sha
json() {
  python3 -c 'import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1:]: value = value[key]
print(value)' "$@"
}

# Records how the deployment went; on the commit, the pull request and under Deployments
status() {
  [[ -n "${DEPLOYMENT_ID:-}" ]] || return 0
  gh -o /dev/null -X POST "https://api.github.com/repos/$REPO/deployments/$DEPLOYMENT_ID/statuses" \
    -d "$(python3 -c 'import json, sys; print(json.dumps({"state": sys.argv[1], "description": sys.argv[2][:140], "environment_url": sys.argv[3]}))' "$1" "$2" "$ENVIRONMENT_URL")" \
    || log "could not report '$1' to GitHub"
}

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
  status failure "$*"
  exit 1
}
on_error() { fail "error on line $1"; }

install -d -m 700 "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "another deploy is running"; exit 0; }

SHA=$(gh "https://api.github.com/repos/$REPO/branches/$BRANCH" | json commit sha)
DEPLOYED=$(cat "$STATE_DIR/deployed" 2>/dev/null || true)
FAILED=$(cat "$STATE_DIR/failed" 2>/dev/null || true)
if [[ "${1:-}" != --force ]]; then
  [[ "$SHA" != "$DEPLOYED" ]] || exit 0
  [[ "$SHA" != "$FAILED" ]] || exit 0
fi
log "deploying $REPO@${SHA:0:7} (deployed: ${DEPLOYED:0:7})"

DEPLOYMENT_ID=$(gh -X POST "https://api.github.com/repos/$REPO/deployments" \
  -d "$(python3 -c 'import json, sys; print(json.dumps({"ref": sys.argv[1], "environment": sys.argv[2], "auto_merge": False, "required_contexts": [], "production_environment": True, "description": "Deployed by the host that runs the API"}))' "$SHA" "$ENVIRONMENT")" | json id)
status in_progress "Downloading and building ${SHA:0:7}"
trap 'on_error $LINENO' ERR

WORK=$(mktemp -d /tmp/tebonsma-api-deploy.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
gh -L -o "$WORK/src.tgz" "https://api.github.com/repos/$REPO/tarball/$SHA"
mkdir "$WORK/src" && tar -xzf "$WORK/src.tgz" -C "$WORK/src" --strip-components=1

STAMP=$(date +%Y-%m-%d-%H%M%S)
sqlite3 "$DB_FILE" ".backup $BACKUP_DIR/db-$STAMP.db"
tar -czf "$BACKUP_DIR/src-$STAMP.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
docker tag "$IMAGE:latest" "$IMAGE:rollback"
find "$BACKUP_DIR" -type f -mtime +"$KEEP_BACKUP_DAYS" -delete

# Folders are replaced whole, so files removed upstream disappear here too
for dir in "${REPO_DIRS[@]}"; do rm -rf "${APP_DIR:?}/$dir"; done
cp -r "$WORK/src/." "$APP_DIR/"
(cd "$APP_DIR" && docker compose up -d --build)

health=starting
for _ in $(seq 1 45); do
  health=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [[ "$health" == healthy ]] && break
  sleep 2
done
[[ "$health" == healthy ]] || fail "the container is $health after 90 seconds"

# The new version must answer like the old one: open endpoints answer, member endpoints ask for a login
docker exec "$CONTAINER" node --input-type=module -e '
const checks = [["/health", 200], ["/feed/posts", 200], ["/events", 200], ["/calendar.ics", 200], ["/me", 401], ["/mail/folders", 401], ["/bet/me", 401]]
let wrong = 0
for (const [path, expected] of checks) {
  const status = await fetch("http://127.0.0.1:8080" + path).then(res => res.status, () => 0)
  if (status !== expected) { wrong++; console.log(`${path} answered ${status}, expected ${expected}`) }
}
process.exit(wrong ? 1 : 0)
' || fail "the new version does not answer as expected"
sqlite3 "$DB_FILE" 'PRAGMA integrity_check;' | grep -qx ok || fail "the database failed its integrity check"

echo "$SHA" >"$STATE_DIR/deployed"
rm -f "$STATE_DIR/failed"
status success "Deployed ${SHA:0:7}"
log "deployed ${SHA:0:7}"
