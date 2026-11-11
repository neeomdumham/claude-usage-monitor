# Shared helpers for session-start.sh and uninstall.sh (POSIX sh; Git Bash on Windows).
HERE=$(cd "$(dirname "$0")" && pwd)
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
