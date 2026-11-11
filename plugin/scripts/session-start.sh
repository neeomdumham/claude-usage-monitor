#!/bin/sh
# usage-monitor SessionStart hook. Never blocks or fails the session: every exit is 0.
# 1) enroll once with the owner's single-use code  2) point telemetry + status line at the monitor
# 3) bind this session to the setup-token fingerprint  4) heartbeat
. "$(dirname "$0")/lib.sh"
DATA="${CLAUDE_PLUGIN_DATA:?}"
SERVER=$(printf '%s' "${CLAUDE_PLUGIN_OPTION_SERVER_URL:-}" | sed 's:/*$::')
CODE="${CLAUDE_PLUGIN_OPTION_ENROLLMENT_CODE:-}"
VERSION=plugin-0.1.0
INPUT=$(cat)
umask 077
mkdir -p "$DATA/bin"

say() { printf '{"systemMessage":"usage-monitor: %s"}\n' "$1"; exit 0; }

case "$SERVER" in
  https://*|http://localhost:*|http://localhost|http://127.0.0.1:*|http://127.0.0.1) ;;
  '') say "set the monitor server URL in /plugin, then restart Claude Code" ;;
  *) say "server URL must use https (plain http only for localhost)" ;;
esac

# --- 1. enrollment (again if the server URL changed) ---
if [ ! -s "$DATA/token" ] || [ "$(cat "$DATA/server_url" 2>/dev/null)" != "$SERVER" ]; then
  case "$CODE" in
    '') say "enter the enrollment code from the monitor dashboard in /plugin, then restart Claude Code" ;;
    *[!A-Za-z0-9_-]*) say "enrollment code looks malformed" ;;
  esac
  RESP=$(curl -sS -m 10 -H 'content-type: application/json' -d "{\"code\":\"$CODE\"}" "$SERVER/api/enroll" 2>/dev/null)
  TOKEN=$(printf '%s' "$RESP" | sed -n 's/.*"token" *: *"\([A-Za-z0-9_-]*\)".*/\1/p')
  [ -n "$TOKEN" ] || say "enrollment failed (code already used or expired?). Ask for a new code and update it in /plugin"
  printf '%s' "$TOKEN" > "$DATA/token"
  printf '%s' "$SERVER" > "$DATA/server_url"
  ENROLLED=1
fi
TOKEN=$(cat "$DATA/token")

# --- 2. settings: helpers live in the stable data dir (the plugin root moves on updates) ---
cp "$HERE/statusline.sh" "$HERE/otel-headers.sh" "$DATA/bin/" && chmod 700 "$DATA/bin/statusline.sh" "$DATA/bin/otel-headers.sh"
CHANGED=$(settings_tool merge "$SETTINGS" "$DATA" "$SERVER/v1/logs" 2>/dev/null) || say "could not update $SETTINGS (needs node, python3, or macOS)"

# --- 3. session -> credential binding. The token is read only from the settings file's env
# (hooks never see it in their own environment) and only its SHA-256 leaves this machine.
SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_-]*\)".*/\1/p')
FP=$(settings_tool token "$SETTINGS" 2>/dev/null | tr -d '\r\n' | { t=$(cat); [ -n "$t" ] && printf '%s' "$t" | sha256; })
case "$FP" in [0-9a-f]*) FPJSON="\"$FP\"" ;; *) FPJSON=null ;; esac
post() { curl -sS -m 5 -o /dev/null -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "$2" "$SERVER$1" 2>/dev/null; }
[ -n "$SID" ] && post /api/agent/sessions "{\"sessionId\":\"$SID\",\"credentialFp\":$FPJSON}"

# --- 4. heartbeat ---
post /api/agent/heartbeat "{\"clientVersion\":\"$VERSION\",\"appliedPolicyRevision\":null,\"capabilities\":{\"otlpDirect\":true,\"statuslineBridge\":true,\"tokenFingerprint\":$([ "$FPJSON" = null ] && echo false || echo true)},\"queueDepth\":0,\"droppedCount\":0}"

if [ -n "${ENROLLED:-}" ] || [ "$CHANGED" = changed ]; then
  say "connected to $SERVER. Usage is measured from your next Claude Code session"
fi
exit 0
