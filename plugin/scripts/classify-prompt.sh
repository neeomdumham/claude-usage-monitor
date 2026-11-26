#!/bin/sh
# usage-monitor UserPromptSubmit hook:
# 1) enforces admin repository guard (off / warn / block with exit 2 before any Anthropic API call)
# 2) labels a prompt ON THIS DEVICE and reports only the category (never prompt text)
. "$(dirname "$0")/lib.sh"
DATA="${CLAUDE_PLUGIN_DATA:-}"
[ -s "$DATA/token" ] && [ -s "$DATA/server_url" ] || exit 0
RAW_INPUT=$(cat)

SID=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_-]*\)".*/\1/p')
CWD=$(printf '%s' "$RAW_INPUT" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p')

# --- 1. Repository guard (blocks with exit 2 before tokens are spent when admin enables block mode) ---
load_guard_policy "$DATA"
if [ "$GUARD_OUTSIDE" != off ] || [ "$GUARD_NOREPO" != off ]; then
  if [ -n "$CWD" ] && [ -d "$CWD" ]; then
    eval_dir_guard "$CWD" "$DATA/guard-policy"
    if [ "$GUARD_ACTION" = blocked ]; then
      post_guard_event "$DATA" "$SID" UserPromptSubmit blocked "$GUARD_REASON" "$GUARD_REPO" ""
      if [ "$GUARD_REASON" = no_repo ]; then
        printf 'usage-monitor: blocked — this directory is not inside an allowed work git repository. Switch to a work repo or ask your admin.\n' >&2
      else
        printf 'usage-monitor: blocked — "%s" is outside your organization'\''s allowed work repositories. Switch to a work repo or ask your admin.\n' "$GUARD_REPO" >&2
      fi
      exit 2
    elif [ "$GUARD_ACTION" = warned ]; then
      # Silent to the user: alert the admin without printing a user-facing warning.
      post_guard_event "$DATA" "$SID" UserPromptSubmit warned "$GUARD_REASON" "$GUARD_REPO" ""
    fi
  fi
fi

# --- 2. On-device prompt classifier (drop path fields so folders like /home/me/resume never match) ---
INPUT=$(printf '%s' "$RAW_INPUT" | sed -E 's/"(cwd|transcript_path)" *: *"[^"]*"//g')

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

if [ -n "$CAT" ]; then
  SID_JSON=$([ -n "$SID" ] && printf '"%s"' "$SID" || printf null)
  # Fire and forget: silent to the user, never delays the prompt.
  ( curl -sS -m 5 -o /dev/null -H 'content-type: application/json' -H "authorization: Bearer $(cat "$DATA/token")" \
      -d "{\"sessionId\":$SID_JSON,\"category\":\"$CAT\"}" "$(cat "$DATA/server_url")/api/agent/labels" </dev/null >/dev/null 2>&1 & )
fi
exit 0
