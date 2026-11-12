# What the usage monitor collects

Our team shares one Claude Team seat. This monitor shows the team admin how the seat's allowance is used,
so everyone keeps access and misuse can be spotted. This page lists everything the plugin on your computer
sends. The list is enforced in code: the server keeps only the fields named here (`apps/server/src/otlp.ts`)
and drops the rest on arrival.

## Who sees it

Only the admin who runs the monitor. Teammates don't have dashboard access, and the monitor shares nothing
with anyone else. Data is deleted after the retention period set on the server (30 days by default).

## Collected

| What | Example | Why |
|---|---|---|
| Allowance readings from the status line | weekly 41%, resets Thu 06:00 | The account-wide meters everyone draws on |
| Each Claude API request: model, effort, token counts, API-priced cost estimate, duration, main conversation vs subagent | `claude-sonnet`, 12k input, 800 output | How much work each person runs |
| Repository the session ran in (git remote, normalized) | `gitlab.com/office/api` | Work repositories vs outside work |
| How Claude Code was started | `cli`, `sdk-cli` | Interactive use vs scripted runs |
| Prompt events: **length only** | 68 characters | Volume of asks, never their content |
| Tool calls: tool name, success, duration, input and output **sizes** | `Bash`, success, 1.2 s | What kind of work Claude did |
| Permission decisions: accepted or rejected, permission mode | `bypassPermissions` | Risky-mode usage |
| Compactions, subagent runs (type, tool count, duration), skill activations, API error status codes | `auto` compaction | Context and reliability |
| Session id, timestamps, your device's hostname and OS, the IP it joined from | `rafi-mbp`, Darwin | Grouping and time-of-day |
| SHA-256 fingerprint of the setup token in your Claude Code settings | `d104be23077b…` | Spotting one token used by several people |

## Never collected

- Your prompts or Claude's responses
- Code, file contents, file paths, diffs
- Command text, tool parameters or tool input (`OTEL_LOG_TOOL_DETAILS` and `OTEL_LOG_USER_PROMPTS` stay off; the server drops these fields even if you turn them on)
- Error messages, branch names, commit hashes
- Your email, account ids, or the setup token itself
- Anything from claude.ai chat, the desktop app or mobile

## What the admin can and can't conclude

The dashboard can show *when*, *where* (which repository) and *how much*. It can't show *what* you asked or
whether the work was good. Its flags (for example "40% of work outside work repositories" or "a lot of
activity between 00:00 and 06:00") are prompts for a conversation, not verdicts. Each flag lists its evidence
and the innocent explanations next to it.

## Leaving

Uninstall the plugin (`claude plugin uninstall usage-monitor@usage-monitor-tools`) and your device stops
reporting. To restore your previous settings, ask the admin, or run `sh plugin/scripts/uninstall.sh` from
this repository. Data already sent is kept until the retention period ends; ask the admin to delete it sooner.
