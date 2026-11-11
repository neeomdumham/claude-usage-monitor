#!/bin/sh
# Owner-run recovery: removes usage-monitor's settings and restores the previous status line.
# Usage: sh uninstall.sh [plugin-data-dir]   (default: ~/.claude/plugins/data/usage-monitor-*)
. "$(dirname "$0")/lib.sh"
DATA=${1:-$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/data/usage-monitor-* 2>/dev/null | head -1)}
[ -d "$DATA" ] || { echo "plugin data dir not found; pass it as the first argument"; exit 1; }
echo "settings: $(settings_tool unmerge "$SETTINGS" "$DATA")"
echo "backup of the original settings (if any): $SETTINGS.usage-monitor-backup"
echo "Then remove the plugin: claude plugin uninstall usage-monitor@usage-monitor-tools"
