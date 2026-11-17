#!/bin/sh
# Runs inside the plugin-e2e container (see scripts/e2e-real.sh): install the plugin the way README tells
# teammates to, then use Claude Code for real. The setup token is mounted read-only and never printed.
set -eu
mkdir -p ~/.claude /tmp/work
umask 077
jq -n --rawfile t /run/setup-token '{env: {CLAUDE_CODE_OAUTH_TOKEN: ($t | rtrimstr("\n"))}}' > ~/.claude/settings.json
echo '{"hasCompletedOnboarding":true,"projects":{"/tmp/work":{"hasTrustDialogAccepted":true}}}' > ~/.claude.json
cd /tmp/work && git init -q && git remote add origin https://gitlab.com/example/e2e-demo.git

echo "# install (README one-liner, local marketplace)"
claude plugin install usage-monitor --marketplace /repo --config "invite=$INVITE"

echo "# session 1: joins"
claude -p 'Reply with the single word ok' --model haiku

if [ "${CAPTURE:-}" = 1 ]; then
  # The admin has content capture on: one session that reads, edits and runs a command.
  echo "# capture settings applied"
  jq -r '.env | to_entries[] | select(.key | test("OTEL_LOG|TRACES|ENHANCED")) | "\(.key)=\(.value)"' ~/.claude/settings.json
  printf 'CAPFILE line one\nold value\n' > notes.txt
  git config user.name e2e && git config user.email e2e@example.invalid
  git add notes.txt && git commit -qm init # a branch to report
  echo "# session 2: read, edit, run"
  claude -p 'CAPMARK: use the Read tool on notes.txt, use the Edit tool to replace the word old with new, run the shell command: echo CAPCMD, then commit with: git commit -am capture-test' \
    --model haiku --allowedTools Read Edit 'Bash(echo:*)' 'Bash(git commit:*)' --permission-mode acceptEdits
  sleep 6 # trace export interval is 5 s; -p flushes logs on exit
  exit 0
fi
echo "# session 2: measured"
claude -p 'Reply with the single word ok' --model haiku

echo "# interactive session: status line reports allowance"
tmux new-session -d -s cc -x 160 -y 40 'claude --model haiku'
sleep 10
tmux send-keys -t cc 'Reply with the single word ok' Enter
sleep 25
tmux capture-pane -pt cc | grep -v '^\s*$' | tail -6
tmux send-keys -t cc '/exit' Enter
sleep 5
