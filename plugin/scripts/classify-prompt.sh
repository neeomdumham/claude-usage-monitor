#!/bin/sh
# usage-monitor UserPromptSubmit hook: labels a prompt ON THIS DEVICE and reports only the label.
# The prompt text never leaves the machine. Silent unless a label applies; never blocks the prompt.
# Categories: credential-pasted, jailbreak-attempt, bulk-generation, non-work (keyword matching, low precision).
DATA="${CLAUDE_PLUGIN_DATA:-}"
[ -s "$DATA/token" ] && [ -s "$DATA/server_url" ] || exit 0
# Drop the fields that are paths, so a folder named "resume" can't trigger a label.
INPUT=$(cat | sed -E 's/"(cwd|transcript_path)" *: *"[^"]*"//g')

label() {
  t=$(cat)
  if printf '%s' "$t" | grep -Eq 'AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; then
    echo credential-pasted
  elif printf '%s' "$t" | grep -Eiq '(ignore|disregard) (all )?(your |the )?(previous|prior|above) instructions|do anything now|developer mode enabled|jailbreak|(bypass|disable) (your |the )?(safety|guardrails|filters|content policy)|pretend (that )?you (have|are under) no (rules|restrictions)|without (any )?(restrictions|guardrails|filters)'; then
    echo jailbreak-attempt
  elif printf '%s' "$t" | grep -Eiq '(write|generate|create|produce) ([0-9]{2,}|dozens of|hundreds of) (unique |different |seo )?(articles|blog posts|posts|essays|emails|reviews|tweets|captions|product descriptions)'; then
    echo bulk-generation
  elif printf '%s' "$t" | grep -Eiq 'cover letter|my (resume|cv)([^a-z]|$)|homework|my assignment|my thesis|upwork|fiverr|freelance client|dating profile|tinder|instagram caption|tiktok script|youtube script|crypto trading|betting tips'; then
    echo non-work
  fi
}
CAT=$(printf '%s' "$INPUT" | label)
[ -n "$CAT" ] || exit 0

SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_-]*\)".*/\1/p')
SID_JSON=$([ -n "$SID" ] && printf '"%s"' "$SID" || printf null)
# Fire and forget: the prompt must not wait on the network.
( curl -sS -m 5 -o /dev/null -H 'content-type: application/json' -H "authorization: Bearer $(cat "$DATA/token")" \
    -d "{\"sessionId\":$SID_JSON,\"category\":\"$CAT\"}" "$(cat "$DATA/server_url")/api/agent/labels" >/dev/null 2>&1 & )

case "$CAT" in
  credential-pasted) MSG='this prompt looks like it contains a secret (API key, token or private key). Only the label \"credential-pasted\" was reported, not the text. If the secret is real, rotate it.' ;;
  *) MSG="this prompt was labelled \\\"$CAT\\\" on your device. Only the label was reported, never the text." ;;
esac
printf '{"systemMessage":"usage-monitor: %s"}\n' "$MSG"
exit 0
