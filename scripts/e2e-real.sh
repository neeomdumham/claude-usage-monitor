#!/bin/sh
# End to end with the real Claude Code CLI: install the plugin from this repo, join with an invite, run
# two headless sessions and one interactive one, then check what reached the monitor.
# Local only (uses a few small Haiku requests on the seat); never run in CI.
#   E2E_TOKEN_FILE=~/.config/claude-usage-monitor/probe-token-a sh scripts/e2e-real.sh
set -eu
cd "$(dirname "$0")/.."
: "${E2E_TOKEN_FILE:?set E2E_TOKEN_FILE to a file holding a setup token}"
[ -r "$E2E_TOKEN_FILE" ] || { echo "cannot read $E2E_TOKEN_FILE"; exit 1; }
export E2E_TOKEN_FILE
DC="docker compose --profile test --profile e2e-real"
API=http://localhost:8788 # plugin-api published on the host; inside the device it is localhost:8787

$DC up -d --build --wait plugin-api >/dev/null
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
curl -sf -c "$JAR" -H 'content-type: application/json' -d '{"password":"pw"}' "$API/api/auth/login" >/dev/null
NAME="E2E $(date +%s)"
TOKEN=$(curl -sf -b "$JAR" -H 'content-type: application/json' -d "{\"name\":\"$NAME\"}" "$API/api/dashboard/invites" | jq -r .token)

$DC run --rm --build -e INVITE="http://localhost:8787/join#$TOKEN" plugin-e2e

q() { $DC exec -T db-plugin psql -U monitor -d monitor -Atqc "$1"; }
INST=$(q "select i.id from installations i join people p on p.id = i.person_id where p.name = '$NAME'")
PASS=0 FAIL=0
check() { # check <name> <sql returning a count>: passes when the count is > 0
  n=$(q "$2")
  if [ "${n:-0}" -gt 0 ]; then PASS=$((PASS + 1)); echo "  ok    $1 ($n)"; else FAIL=$((FAIL + 1)); echo "  FAIL  $1"; fi
}
echo "# what reached the monitor"
[ -n "$INST" ] || { echo "  FAIL  device never joined"; exit 1; }
check "device joined with plugin version" "select count(*) from installations where id = $INST and client_version like 'plugin-%'"
check "sessions bound to the setup-token fingerprint" "select count(*) from session_bindings where installation_id = $INST and credential_id is not null"
check "api requests (models, tokens)" "select count(*) from usage_events where installation_id = $INST"
check "repository attached to requests" "select count(*) from usage_events where installation_id = $INST and repo like '%e2e-demo%'"
check "activity events" "select count(*) from activity_events where installation_id = $INST"
check "metrics" "select count(*) from metric_points where installation_id = $INST"
# An unchanged reading extends the row an earlier device created, so check freshness, not the observer.
check "allowance meters from the status line" "select count(*) from quota_snapshots where last_observed_at > now() - interval '10 minutes'"
echo "# raw content check"
LEAK=$($DC exec -T db-plugin pg_dump -U monitor monitor --data-only | grep -c 'Reply with the single word' || true)
if [ "$LEAK" = 0 ]; then PASS=$((PASS + 1)); echo "  ok    no prompt text stored"; else FAIL=$((FAIL + 1)); echo "  FAIL  prompt text stored"; fi

echo "# content capture on: a second device, with every switch on"
policy() { curl -sf -b "$JAR" -X PATCH -H 'content-type: application/json' -d "$1" "$API/api/dashboard/policy" >/dev/null; }
policy '{"capturePrompts":true,"captureToolDetails":true,"captureFileContent":true,"captureErrors":true}'
trap 'policy "{\"capturePrompts\":false,\"captureToolDetails\":false,\"captureFileContent\":false,\"captureErrors\":false}"; rm -f "$JAR"' EXIT
NAME2="E2E capture $(date +%s)"
TOKEN=$(curl -sf -b "$JAR" -H 'content-type: application/json' -d "{\"name\":\"$NAME2\"}" "$API/api/dashboard/invites" | jq -r .token)
$DC run --rm -e CAPTURE=1 -e INVITE="http://localhost:8787/join#$TOKEN" plugin-e2e
INST2=$(q "select i.id from installations i join people p on p.id = i.person_id where p.name = '$NAME2'")
c() { echo "select count(*) from content_events where installation_id = ${INST2:-0} and $1"; }
check "prompt text" "$(c "kind = 'prompt' and text like 'CAPMARK%'")"
check "shell command" "$(c "kind = 'command' and text like '%echo CAPCMD%'")"
check "file read with path (traces, authenticated by the headers helper)" "$(c "kind = 'file_read' and file_path like '%notes.txt' and text like '%CAPFILE%'")"
check "edit diff, unified" "$(c "kind = 'diff' and text like '@@ %+new value%'")"
check "command output" "$(c "kind = 'output' and text like '%CAPCMD%'")"
check "branch recorded" "$(c "branch is not null")"
LEAK=$($DC exec -T db-plugin pg_dump -U monitor monitor --data-only | grep -c 'sk-ant-oat' || true)
if [ "$LEAK" = 0 ]; then PASS=$((PASS + 1)); echo "  ok    setup token never stored"; else FAIL=$((FAIL + 1)); echo "  FAIL  setup token stored"; fi
q "select kind, coalesce(tool_name, ''), left(replace(text, chr(10), ' '), 60) from content_events where installation_id = ${INST2:-0} order by id"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
