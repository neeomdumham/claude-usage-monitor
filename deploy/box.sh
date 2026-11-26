#!/bin/sh
# Runs ON the server, as root, through SSM (.github/workflows/release.yml or scripts/release.sh fetches it with
# compose.yml and the Caddyfile at the release tag). Pull the image, switch APP_IMAGE in .env, start, health-check,
# and roll back to the previous image if the app doesn't come up healthy.
#   box.sh <image>        e.g. box.sh ghcr.io/neeomdumham/claude-usage-monitor:0.5.7
set -eu
IMAGE="$1"
cd "${MONITOR_DIR:-/opt/monitor}"
test -f .env || { echo "/opt/monitor/.env is missing: cp env.example .env, fill it in, then deploy again"; exit 1; }

PREV=$(sed -n 's/^APP_IMAGE=//p' .env)
# Rewrites in place (cat >) so the file keeps its owner and 600 mode.
set_image() { grep -v '^APP_IMAGE=' .env > .env.new || true; echo "APP_IMAGE=$1" >> .env.new; cat .env.new > .env; rm .env.new; }
healthy() {
  for _ in $(seq 1 45); do
    docker compose exec -T app wget -qO- http://127.0.0.1:8787/api/health > /dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

docker pull -q "$IMAGE"
set_image "$IMAGE"
docker compose up -d --remove-orphans
if healthy; then
  docker image prune -f > /dev/null
  echo "deployed $IMAGE"
  exit 0
fi

echo "health check failed for $IMAGE"
docker compose logs --tail 40 app
if [ -n "$PREV" ] && [ "$PREV" != "$IMAGE" ] && docker image inspect "$PREV" > /dev/null 2>&1; then
  echo "rolling back to $PREV"
  set_image "$PREV"
  docker compose up -d
  healthy && echo "rolled back to $PREV" || echo "rollback is unhealthy too"
fi
exit 1
