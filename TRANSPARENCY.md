# What the usage monitor collects

Our team shares one Claude Team seat. This monitor shows the team admin how the seat's allowance is used,
so everyone keeps access and misuse can be spotted. This page lists everything the plugin on your computer
sends. The list is enforced in code: the server keeps only the fields named here (`apps/server/src/otlp.ts`)
and drops the rest on arrival.

## Who sees it

Only the admin who runs the monitor. Teammates don't have dashboard access, and the monitor shares nothing
with anyone else. How long it's kept:

- Requests, tool and prompt events, prompt labels, Claude Code's counts and GitLab commits: deleted after the
  retention period set on the server (30 days by default).
- The audit log, a record of admin actions and device events (joins, and each prompt label's category): one year.
- Allowance readings, your device's record (hostname, OS, join IP) and the token fingerprint: no time limit.
  Removing a device stops it reporting but keeps its record; deleting it is done by the admin in the database.

## Collected

| What | Example | Why |
|---|---|---|
| Allowance readings from the status line | weekly 41%, resets Thu 06:00 | The account-wide meters everyone draws on |
| Each Claude API request: model, effort, fast mode, token counts, API-priced cost estimate, duration, main conversation vs subagent | `claude-sonnet`, 12k input, 800 output | How much work each person runs |
| Repository the session ran in (git remote, normalized) | `gitlab.com/office/api` | Work repositories vs outside work |
| How Claude Code was started | `cli`, `sdk-cli` | Interactive use vs scripted runs |
| Prompt events: **length only**, plus the slash command's name and source when the prompt is one | 68 characters, `/review` | Volume of asks, never their content |
| Tool calls: tool name, success, duration, input and output **sizes** | `Bash`, success, 1.2 s | What kind of work Claude did |
| Permission decisions: accepted or rejected, permission mode | `bypassPermissions` | Risky-mode usage |
| Compactions, subagent runs (type, tool count, duration), skill activations (skill name), permission-mode switches, API error status codes and retry attempt, session starts (new or resumed) | `auto` compaction | Context and reliability |
| Session, prompt and request ids, timestamps, your device's hostname and OS, the IP it joined from | `rafi-mbp`, Darwin | Grouping and time-of-day |
| SHA-256 fingerprint of the setup token in your Claude Code settings (none if the token only lives in your shell profile) | `d104be23077b…` | Spotting one token used by several people |
| Counts Claude Code keeps itself: commits and pull/merge requests Claude made, lines Claude added or removed, edits accepted or rejected (with file language), time you were active vs time Claude was working | 2 commits, +120/−30 lines | What the work produced |
| Plugin version and whether a token fingerprint was found, sent at each session start | `plugin-0.4.0` | Spotting outdated or misconfigured devices |
| A **label** for a prompt, decided on your computer (see below), with the session id | `credential-pasted` | Spotting misuse without reading prompts |
| Commits in the team's GitLab group: author email, time, lines added/removed (fetched by the server from GitLab, not from your computer) | `rafi@company.com`, +40/−12 | Comparing Claude's output with all output |

## Prompt labels

Before a prompt is sent, the plugin checks it on your computer against a short keyword list
(`plugin/scripts/classify-prompt.sh`, readable in this repo). If it matches, only the category name is
sent to the monitor, never the prompt or any part of it, and Claude Code shows you a notice saying so.
The categories:

- `credential-pasted`: something shaped like an API key, access token or private key
- `jailbreak-attempt`: phrases such as "ignore previous instructions" or "without restrictions"
- `bulk-generation`: asks for dozens of articles, posts, emails or reviews at once
- `non-work`: keywords such as résumés, homework, freelance platforms or social media content

Keyword matching is crude: it misses things and it misfires. A label is a reason for a conversation,
never proof of anything.

## Never collected

- Your prompts or Claude's responses
- Code, file contents, file paths, diffs
- Command text, tool parameters or tool input (`OTEL_LOG_TOOL_DETAILS` and `OTEL_LOG_USER_PROMPTS` stay off; the server drops these fields even if you turn them on)
- Error messages, branch names, commit messages, diffs
- Your Claude account email or account ids (the server drops them), or the setup token itself
- Anything from claude.ai chat, the desktop app or mobile

## What the admin can and can't conclude

The dashboard can show *when*, *where* (which repository), *how much*, and which prompts got a label. It
can't show *what* you asked or whether the work was good. Its flags (for example "40% of work outside work repositories" or "a lot of
activity between 00:00 and 06:00", "a lot of scripted use", "sessions on two devices at once", or a
prompt label) are prompts for a conversation, not verdicts. Each flag lists its evidence
and the innocent explanations next to it.

## Leaving

Uninstall the plugin (`claude plugin uninstall usage-monitor@usage-monitor-tools`) and your device stops
reporting. To restore your previous settings, ask the admin, or run `sh plugin/scripts/uninstall.sh` from
this repository. Data already sent is kept as described under "Who sees it"; ask the admin to delete it sooner.
