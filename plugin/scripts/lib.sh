# Shared helpers for plugin hooks and uninstall.sh (POSIX sh; Git Bash on Windows).
HERE=$(cd "$(dirname "$0")" && pwd)
# Files written here (settings backup, token, cached guard policy) stay private.
umask 077
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

# JSON edits without a guaranteed runtime: node, then macOS JXA, then python3.
# (macOS ships a python3 stub that pops an install dialog, so JXA goes before python there.)
settings_tool() {
  if command -v node >/dev/null 2>&1; then node "$HERE/settings.cjs" "$@"
  elif [ "$(uname)" = Darwin ]; then osascript -l JavaScript "$HERE/settings.cjs" "$@"
  elif command -v python3 >/dev/null 2>&1; then python3 "$HERE/settings.py" "$@"
  elif command -v python >/dev/null 2>&1; then python "$HERE/settings.py" "$@"
  else return 1
  fi
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum
  else openssl dgst -sha256 -r
  fi | cut -d' ' -f1
}

# Normalize a git remote URL to host/owner/name (matches apps/server/src/otlp.ts:normalizeRepo).
normalize_repo() {
  printf '%s' "$1" | sed -E \
    -e 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    -e 's/^[A-Za-z][A-Za-z0-9+.-]*:\/\///' \
    -e 's/^[^@\/]*@//' \
    -e 's/^([^\/:]+):([^0-9])/\1\/\2/' \
    -e 's/\/+$//' \
    -e 's/\.git$//' \
    -e 's/\/+$//' | tr '[:upper:]' '[:lower:]'
}

# Walk up from a path until an existing directory is found (handles not-yet-created subdirectories).
nearest_dir() {
  _nd="$1"
  while [ -n "$_nd" ] && [ "$_nd" != "/" ] && [ ! -d "$_nd" ]; do
    _nd=$(dirname "$_nd")
  done
  [ -d "$_nd" ] && printf '%s' "$_nd"
}

# Return the normalized primary git remote for a directory, or empty if not in a git repo with a remote.
repo_for_dir() {
  _rdir="$1"
  [ -n "$_rdir" ] && [ -d "$_rdir" ] || return 0
  command -v git >/dev/null 2>&1 || return 0
  _rurl=$(git -C "$_rdir" remote get-url origin 2>/dev/null || true)
  if [ -z "$_rurl" ]; then
    _rfirst=$(git -C "$_rdir" remote 2>/dev/null | head -n 1)
    [ -n "$_rfirst" ] && _rurl=$(git -C "$_rdir" remote get-url "$_rfirst" 2>/dev/null || true)
  fi
  [ -n "$_rurl" ] && normalize_repo "$_rurl"
}

# Cache guard policy (modes + merged org/team workNamespaces) from /api/agent/policy JSON.
write_guard_policy() {
  _gp_json="$1"
  _gp_file="$2"
  case "$_gp_json" in *'"revision"'*) ;; *) return 1 ;; esac
  _gp_out=$(printf '%s' "$_gp_json" | sed -n 's/.*"outsideRepoMode" *: *"\([a-z]*\)".*/\1/p')
  _gp_no=$(printf '%s' "$_gp_json" | sed -n 's/.*"noRepoMode" *: *"\([a-z]*\)".*/\1/p')
  _gp_ns=$(printf '%s' "$_gp_json" | sed -n 's/.*"workNamespaces" *: *\[\([^]]*\)\].*/\1/p')
  _gp_tmp="${_gp_file}.tmp.$$"
  {
    printf 'UPDATED=%s\n' "$(date +%s)"
    printf 'OUTSIDE=%s\n' "${_gp_out:-off}"
    printf 'NOREPO=%s\n' "${_gp_no:-off}"
    if [ -n "$_gp_ns" ]; then
      printf '%s\n' "$_gp_ns" | tr ',' '\n' | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//' | tr '[:upper:]' '[:lower:]' | while IFS= read -r _ns; do
        [ -n "$_ns" ] && printf 'NS=%s\n' "$_ns"
      done
    fi
  } > "$_gp_tmp" && mv "$_gp_tmp" "$_gp_file"
}

# Load guard policy into GUARD_OUTSIDE and GUARD_NOREPO; refresh from server if missing or >60s old.
load_guard_policy() {
  _lg_data="$1"
  _lg_file="$_lg_data/guard-policy"
  _lg_now=$(date +%s)
  _lg_updated=0
  if [ -s "$_lg_file" ]; then
    _lg_updated=$(sed -n 's/^UPDATED=\([0-9]*\)$/\1/p' "$_lg_file" | head -n 1)
    _lg_updated=${_lg_updated:-0}
  fi
  if [ ! -s "$_lg_file" ] || [ $((_lg_now - _lg_updated)) -ge 60 ]; then
    if [ -s "$_lg_data/token" ] && [ -s "$_lg_data/server_url" ]; then
      _lg_pol=$(curl -sS -m 2 -H "authorization: Bearer $(cat "$_lg_data/token")" "$(cat "$_lg_data/server_url")/api/agent/policy" 2>/dev/null || true)
      write_guard_policy "$_lg_pol" "$_lg_file" 2>/dev/null || true
    fi
  fi
  GUARD_OUTSIDE=off
  GUARD_NOREPO=off
  if [ -s "$_lg_file" ]; then
    _lg_o=$(sed -n 's/^OUTSIDE=\([a-z]*\)$/\1/p' "$_lg_file" | head -n 1)
    _lg_n=$(sed -n 's/^NOREPO=\([a-z]*\)$/\1/p' "$_lg_file" | head -n 1)
    [ -n "$_lg_o" ] && GUARD_OUTSIDE="$_lg_o"
    [ -n "$_lg_n" ] && GUARD_NOREPO="$_lg_n"
  fi
}

# Return 0 if repo matches any work namespace (or if no namespaces are configured), 1 if outside work.
repo_matches_namespaces() {
  _rm_repo="$1"
  _rm_file="$2"
  [ -s "$_rm_file" ] || return 0
  _rm_count=0
  _rm_matched=0
  while IFS= read -r _rm_line; do
    case "$_rm_line" in
      NS=*)
        _rm_ns=${_rm_line#NS=}
        _rm_ns=$(printf '%s' "$_rm_ns" | sed -E 's/\/+$//')
        [ -n "$_rm_ns" ] || continue
        _rm_count=$((_rm_count + 1))
        case "$_rm_repo" in
          "$_rm_ns"|"$_rm_ns"/*) _rm_matched=1 ;;
        esac
        ;;
    esac
  done < "$_rm_file"
  [ "$_rm_count" -eq 0 ] || [ "$_rm_matched" -eq 1 ]
}

# Evaluate a directory against cached guard policy. Sets GUARD_ACTION, GUARD_REASON, GUARD_REPO.
eval_dir_guard() {
  _ed_dir="$1"
  _ed_file="$2"
  GUARD_ACTION=
  GUARD_REASON=
  GUARD_REPO=$(repo_for_dir "$_ed_dir")
  if [ -z "$GUARD_REPO" ]; then
    case "$GUARD_NOREPO" in
      block) GUARD_ACTION=blocked; GUARD_REASON=no_repo ;;
      warn)  GUARD_ACTION=warned;  GUARD_REASON=no_repo ;;
    esac
  elif ! repo_matches_namespaces "$GUARD_REPO" "$_ed_file"; then
    case "$GUARD_OUTSIDE" in
      block) GUARD_ACTION=blocked; GUARD_REASON=outside_repo ;;
      warn)  GUARD_ACTION=warned;  GUARD_REASON=outside_repo ;;
    esac
  fi
}

# Fire-and-forget guard telemetry to /api/agent/guard. Never blocks or fails the hook.
post_guard_event() {
  _pg_data="$1"
  _pg_sid=$(printf '%s' "$2" | tr -cd 'A-Za-z0-9_-' | cut -c1-120)
  _pg_hook="$3"
  _pg_act="$4"
  _pg_reason="$5"
  _pg_repo=$(printf '%s' "$6" | tr -cd 'A-Za-z0-9._/:@-' | cut -c1-200)
  _pg_tool=$(printf '%s' "${7:-}" | tr -cd 'A-Za-z0-9._-' | cut -c1-60)
  [ -s "$_pg_data/token" ] && [ -s "$_pg_data/server_url" ] || return 0
  _pg_sid_j=$([ -n "$_pg_sid" ] && printf '"%s"' "$_pg_sid" || printf null)
  _pg_repo_j=$([ -n "$_pg_repo" ] && printf '"%s"' "$_pg_repo" || printf null)
  _pg_tool_j=$([ -n "$_pg_tool" ] && printf '"%s"' "$_pg_tool" || printf null)
  _pg_body="{\"sessionId\":$_pg_sid_j,\"hook\":\"$_pg_hook\",\"action\":\"$_pg_act\",\"reason\":\"$_pg_reason\",\"repo\":$_pg_repo_j,\"toolName\":$_pg_tool_j}"
  ( curl -sS -m 5 -o /dev/null -H 'content-type: application/json' \
      -H "authorization: Bearer $(cat "$_pg_data/token")" \
      -d "$_pg_body" "$(cat "$_pg_data/server_url")/api/agent/guard" </dev/null >/dev/null 2>&1 & )
}
