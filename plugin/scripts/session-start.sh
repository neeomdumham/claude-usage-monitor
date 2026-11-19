#!/bin/sh
# usage-monitor SessionStart hook. Never blocks or fails the session: every exit is 0.
# 1) join once with the admin's invite link  2) point telemetry + status line at the monitor
# 3) bind this session to the setup-token fingerprint  4) heartbeat
. "$(dirname "$0")/lib.sh"
DATA="${CLAUDE_PLUGIN_DATA:?}"
INVITE=$(printf '%s' "${CLAUDE_PLUGIN_OPTION_INVITE:-}" | tr -d ' \r\n"\\')
# Single source of truth: the release job checks the tag against plugin.json too.
VERSION=plugin-$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$HERE/../.claude-plugin/plugin.json")
TRANSPARENCY=https://gitlab.com/moeen-mahmud/claude-usage-monitor/-/blob/main/TRANSPARENCY.md
INPUT=$(cat)
mkdir -p "$DATA/bin"

say() { printf '{"systemMessage":"usage-monitor: %s"}\n' "$1"; exit 0; }
clean() { tr -cd 'A-Za-z0-9 ._-' | cut -c1-"${1:-60}"; } # safe inside JSON strings

# --- 1. join: once per invite link. The server URL is the link's origin; the secret is after '#'. ---
INVITE_FP=$(printf '%s' "$INVITE" | sha256)
if [ ! -s "$DATA/token" ] || { [ -n "$INVITE" ] && [ "$(cat "$DATA/invite_fp" 2>/dev/null)" != "$INVITE_FP" ]; }; then
  [ -n "$INVITE" ] || say "paste the invite link from your team admin in /plugin (usage-monitor > Configure options), then restart Claude Code"
  SERVER=${INVITE%%/join#*}
  CODE=${INVITE#*/join#}
  case "$SERVER" in
    https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
    *) say "that invite link doesn't look right (expected https://.../join#ccm_inv_...). Ask your admin for a new one" ;;
  esac
  case "$CODE" in ccm_inv_*) ;; *) say "that invite link is incomplete. Copy the whole link, including the part after #" ;; esac
  case "$CODE" in *[!A-Za-z0-9_-]*) say "that invite link is malformed. Ask your admin for a new one" ;; esac
  HOST=$(hostname 2>/dev/null || uname -n); HOST=$(printf '%s' "$HOST" | sed 's/\.local$//' | clean)
  OS=$(uname -s 2>/dev/null | clean 40)
  RESP=$(curl -sS -m 10 -H 'content-type: application/json' \
    -d "{\"invite\":\"$CODE\",\"hostname\":\"$HOST\",\"os\":\"$OS\",\"pluginVersion\":\"$VERSION\"}" "$SERVER/api/enroll" 2>/dev/null)
  TOKEN=$(printf '%s' "$RESP" | sed -n 's/.*"token" *: *"\([A-Za-z0-9_-]*\)".*/\1/p')
  [ -n "$TOKEN" ] || say "couldn't join $SERVER: the invite is used up, expired or replaced. Ask your admin for a new link and update it in /plugin"
  PERSON=$(printf '%s' "$RESP" | sed -n 's/.*"person" *: *"\([^"]*\)".*/\1/p' | clean)
  printf '%s' "$TOKEN" > "$DATA/token"
  printf '%s' "$SERVER" > "$DATA/server_url"
  printf '%s' "$INVITE_FP" > "$DATA/invite_fp"
  JOINED=1
fi
SERVER=$(cat "$DATA/server_url")
TOKEN=$(cat "$DATA/token")

# --- content capture the admin switched on. Offline: keep what was applied last time. ---
POLICY=$(curl -sS -m 5 -H "authorization: Bearer $TOKEN" "$SERVER/api/agent/policy" 2>/dev/null)
case "$POLICY" in
  *'"revision"'*)
    CAPTURE=
    for pair in capturePrompts:prompts captureToolDetails:tools captureFileContent:content captureErrors:errors captureGitDetails:git; do
      case "$POLICY" in *"\"${pair%%:*}\":true"*) CAPTURE="${CAPTURE:+$CAPTURE,}${pair#*:}" ;; esac
    done ;;
  *) CAPTURE=$(cat "$DATA/capture" 2>/dev/null) ;;
esac
# Plain words for the notices (no quotes: they go into a JSON string).
describe() {
  d=
  for c in $(printf '%s' "$1" | tr ',' ' '); do
    case "$c" in
      prompts) w='the text of your prompts' ;;
      tools) w='commands Claude runs, tool inputs, tool errors and the git branch' ;;
      content) w='file paths, contents of files Claude reads or writes, diffs and command output' ;;
      errors) w='API error messages' ;;
      git) w='commit messages and diffs from GitLab' ;;
      *) continue ;;
    esac
    d="${d:+$d; }$w"
  done
  printf '%s' "$d"
}

# --- 2. settings: helpers live in the stable data dir (the plugin root moves on updates) ---
cp "$HERE/statusline.sh" "$HERE/otel-headers.sh" "$DATA/bin/" && chmod 700 "$DATA/bin/statusline.sh" "$DATA/bin/otel-headers.sh"
CHANGED=$(settings_tool merge "$SETTINGS" "$DATA" "$SERVER/v1/logs" "$CAPTURE" 2>/dev/null) || say "could not update $SETTINGS (needs node, python3, or macOS)"

# --- 3. session -> credential binding. The token is read only from the settings file's env
# (hooks never see it in their own environment) and only its SHA-256 leaves this machine.
SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_-]*\)".*/\1/p')
FP=$(settings_tool token "$SETTINGS" 2>/dev/null | tr -d '\r\n' | { t=$(cat); [ -n "$t" ] && printf '%s' "$t" | sha256; })
case "$FP" in [0-9a-f]*) FPJSON="\"$FP\"" ;; *) FPJSON=null ;; esac
post() { curl -sS -m 5 -o /dev/null -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "$2" "$SERVER$1" 2>/dev/null; }
[ -n "$SID" ] && post /api/agent/sessions "{\"sessionId\":\"$SID\",\"credentialFp\":$FPJSON}"

# --- 4. heartbeat ---
post /api/agent/heartbeat "{\"clientVersion\":\"$VERSION\",\"appliedPolicyRevision\":null,\"capabilities\":{\"otlpDirect\":true,\"statuslineBridge\":true,\"tokenFingerprint\":$([ "$FPJSON" = null ] && echo false || echo true)},\"queueDepth\":0,\"droppedCount\":0}"

printf '%s' "$CAPTURE" > "$DATA/capture"
NOW_CAPTURED=$(describe "$CAPTURE")
if [ -n "${JOINED:-}" ]; then
  say "connected to $SERVER as ${PERSON:-you} ($HOST). Your admin sees usage metadata from this device: allowance %, models, token counts, tool, skill and slash-command names, permission modes, repository name, commit and line counts, and times. ${NOW_CAPTURED:+Your admin has also turned on capture of: $NOW_CAPTURED. Secrets are redacted on arrival. }Your setup token is never sent. Details: $TRANSPARENCY. Measuring starts with your next session"
fi
if [ "$CHANGED" = changed ]; then
  say "settings updated for $SERVER. Takes effect from your next session"
fi
exit 0
