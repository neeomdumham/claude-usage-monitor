#!/bin/sh
# usage-monitor status line: renders the user's previous status line unchanged, then reports
# allowance meters (rate_limits) to the monitor in the background. Must stay fast and silent.
DATA=$(cd "$(dirname "$0")/.." && pwd)
INPUT=$(cat)

if [ -s "$DATA/prev_statusline" ]; then
  printf '%s' "$INPUT" | sh -c "$(cat "$DATA/prev_statusline")"
fi

case "$INPUT" in *'"rate_limits"'*) ;; *) exit 0 ;; esac
[ -s "$DATA/token" ] && [ -s "$DATA/server_url" ] || exit 0

# Pure-sh extraction: isolate the rate_limits object, then each window {used_percentage, resets_at}.
RL=$(printf '%s' "${INPUT#*\"rate_limits\"}" | tr -d ' \t\r\n' | sed 's/^://; s/}}.*/}}/')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SNAPS=
KEY=
for W in $(printf '%s' "$RL" | grep -o '"[a-z0-9_]*":{[^{}]*}'); do
  NAME=$(printf '%s' "$W" | sed 's/^"\([a-z0-9_]*\)".*/\1/')
  [ "$NAME" = spend_limit ] && continue # gateway dollars, not a subscription allowance
  PCT=$(printf '%s' "$W" | sed -n 's/.*"used_percentage":\([0-9.]*\).*/\1/p')
  RESET=$(printf '%s' "$W" | sed -n 's/.*"resets_at":\([0-9]*\).*/\1/p')
  [ -n "$PCT" ] && [ -n "$RESET" ] || continue
  SNAPS="$SNAPS${SNAPS:+,}{\"meterKey\":\"$NAME\",\"label\":null,\"usedPercentage\":$PCT,\"resetsAt\":$RESET,\"observedAt\":\"$NOW\",\"source\":\"statusline\"}"
  KEY="$KEY$NAME=$PCT@$RESET;"
done
[ -n "$SNAPS" ] || exit 0

# Throttle: an unchanged reading is re-sent at most once a minute (keeps freshness, bounds traffic).
STAMP="$DATA/statusline-last"
NOWS=$(date +%s)
if [ -f "$STAMP" ]; then
  read -r LKEY LAT < "$STAMP"
  [ "$LKEY" = "$KEY" ] && [ $((NOWS - ${LAT:-0})) -lt 60 ] && exit 0
fi
printf '%s %s\n' "$KEY" "$NOWS" > "$STAMP"

( curl -s -m 2 -o /dev/null -H 'content-type: application/json' -H "authorization: Bearer $(cat "$DATA/token")" \
    -d "{\"events\":[],\"snapshots\":[$SNAPS]}" "$(cat "$DATA/server_url")/api/agent/events" >/dev/null 2>&1 & )
exit 0
