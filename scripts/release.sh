#!/bin/sh
# Release from this machine, no CI: test, build, push to Docker Hub, tag, GitLab Release, deploy to the server.
#   sh scripts/release.sh <version>                  full release (version = plugin/.claude-plugin/plugin.json)
#   sh scripts/release.sh <version> --skip-tests     you just ran them
#   sh scripts/release.sh <version> --deploy-only    redeploy or roll back to an already released version
# Needs: docker (logged in to Docker Hub), glab (logged in), aws (credentials for the account with the stack).
set -eu
V="${1:?usage: release.sh <version> [--skip-tests|--deploy-only]}"
MODE="${2:-}"
HUB="${DOCKERHUB_IMAGE:-docker.io/moeenmahmud007/claude-usage-monitor}"
STACK="${STACK:-usage-monitor}"
export AWS_REGION="${AWS_REGION:-ap-southeast-1}" AWS_PROFILE="${AWS_PROFILE:-velacrew-dev}" # account 544471418460
RAW="https://gitlab.com/moeen-mahmud/claude-usage-monitor/-/raw/v$V/deploy"
die() { echo "release: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."

if [ "$MODE" != --deploy-only ]; then
  [ -z "$(git status --porcelain)" ] || die "working tree not clean: commit or stash first"
  [ "$(git branch --show-current)" = main ] || die "release from main"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not pushed (or is behind origin)"
  PLUGIN=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' plugin/.claude-plugin/plugin.json)
  # Devices compare their plugin against this version, so the two must match.
  [ "$PLUGIN" = "$V" ] || die "plugin.json says $PLUGIN, not $V: bump it and commit first"
  ! git rev-parse -q --verify "refs/tags/v$V" > /dev/null || die "tag v$V already exists"

  if [ "$MODE" != --skip-tests ]; then
    docker compose --profile test run --rm --build test
    docker compose --profile test run --rm --build plugin-test
    docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e db-e2e app-e2e e2e
    docker compose --profile e2e down -v
  fi

  # arm64 only: the server is Graviton, and that's the native build on Apple silicon.
  docker buildx build --platform linux/arm64 --target prod --push \
    --label org.opencontainers.image.version="$V" --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
    -t "$HUB:$V" -t "$HUB:${V%.*}" -t "$HUB:latest" .

  git tag "v$V" && git push -q origin "v$V"
  glab release create "v$V" --name "v$V" --notes "Server image: \`$HUB:$V\` (also \`${V%.*}\`, \`latest\`), linux/arm64.

Teammates update the plugin with \`claude plugin update usage-monitor@usage-monitor-tools\` and restart Claude Code."
fi

ID=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
[ -n "$ID" ] && [ "$ID" != None ] || die "no InstanceId output on stack $STACK"
# Files come from the public repo at the release tag; nothing secret is in the command text.
# shellcheck disable=SC2016 # $f expands on the server, not here
CMD=$(printf '{"commands":["set -e","mkdir -p /opt/monitor && cd /opt/monitor","for f in box.sh compose.yml Caddyfile env.example; do curl -fsSLO %s/$f; done","sh box.sh %s:%s"]}' "$RAW" "$HUB" "$V")
CID=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript --comment "deploy $V" \
  --timeout-seconds 600 --parameters "$CMD" --query Command.CommandId --output text)
echo "deploying $V to $ID (SSM command $CID)"
STATUS=Pending
for _ in $(seq 1 60); do
  STATUS=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$ID" --query Status --output text 2> /dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) sleep 5 ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$ID" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
[ "$STATUS" = Success ] || die "deploy $STATUS"
echo "released $V"
