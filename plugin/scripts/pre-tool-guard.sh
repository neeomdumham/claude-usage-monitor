#!/bin/sh
# usage-monitor PreToolUse hook: blocks file edits or Bash directory escapes outside allowed work repositories
# when the admin enables block mode (exit 2 stops the tool call immediately).
. "$(dirname "$0")/lib.sh"
DATA="${CLAUDE_PLUGIN_DATA:-}"
[ -s "$DATA/token" ] && [ -s "$DATA/server_url" ] || exit 0
RAW_INPUT=$(cat)

load_guard_policy "$DATA"
if [ "$GUARD_OUTSIDE" = off ] && [ "$GUARD_NOREPO" = off ]; then
  exit 0
fi

SID=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_-]*\)".*/\1/p')
CWD=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p')
TOOL=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"tool_name" *: *"\([A-Za-z0-9_.-]*\)".*/\1/p')

block_tool() {
  _bt_reason="$1"
  _bt_repo="$2"
  post_guard_event "$DATA" "$SID" PreToolUse blocked "$_bt_reason" "$_bt_repo" "$TOOL"
  if [ -n "$_bt_repo" ]; then
    printf 'usage-monitor: blocked %s in "%s" (outside allowed work repositories).\n' "${TOOL:-tool}" "$_bt_repo" >&2
  else
    printf 'usage-monitor: blocked %s outside any allowed work git repository.\n' "${TOOL:-tool}" >&2
  fi
  exit 2
}

# 1. Check the session's own working directory first.
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  eval_dir_guard "$CWD" "$DATA/guard-policy"
  [ "$GUARD_ACTION" = blocked ] && block_tool "$GUARD_REASON" "$GUARD_REPO"
fi

# 2. Check target paths for file-editing tools and explicit directory escapes in Bash commands.
TARGET=
case "$TOOL" in
  Edit|Write|MultiEdit|NotebookEdit)
    TARGET=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"file_path" *: *"\([^"]*\)".*/\1/p')
    [ -z "$TARGET" ] && TARGET=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"notebook_path" *: *"\([^"]*\)".*/\1/p')
    [ -z "$TARGET" ] && TARGET=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"path" *: *"\([^"]*\)".*/\1/p')
    ;;
  Bash)
    CMD=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"command" *: *"\([^"]*\)".*/\1/p')
    TARGET=$(printf '%s\n' "$CMD" | sed -nE 's/.*(^|[;&|[:space:]])(cd|pushd|git[[:space:]]+-C)[[:space:]]+["'\'']?([^"'\'' ;&|]+).*/\3/p' | head -n 1)
    ;;
esac

if [ -n "$TARGET" ]; then
  case "$TARGET" in
    [~]/*) TARGET="$HOME/${TARGET#??}" ;;
    [~])   TARGET="$HOME" ;;
  esac
  case "$TARGET" in
    /*) ABS="$TARGET" ;;
    *)  ABS="${CWD%/}/$TARGET" ;;
  esac
  case "$TOOL" in
    Bash) CHECK_DIR=$(nearest_dir "$ABS") ;;
    *)    CHECK_DIR=$(nearest_dir "$(dirname "$ABS")") ;;
  esac
  if [ -n "$CHECK_DIR" ]; then
    eval_dir_guard "$CHECK_DIR" "$DATA/guard-policy"
    [ "$GUARD_ACTION" = blocked ] && block_tool path_escape "$GUARD_REPO"
  fi
fi

exit 0
