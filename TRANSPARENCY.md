# What the usage monitor collects

Our teams share a few Claude accounts (Team seats or logins), each used through teammates' setup tokens. This
monitor shows admins how each account's allowance is used, so everyone keeps access and misuse can be spotted. This page lists everything the plugin on your computer
sends. The list is enforced in code: the server keeps only the fields named here (`apps/server/src/otlp.ts`)
and drops the rest on arrival.

**Two levels.** Usage metadata (the first table below) is always collected. Content (your prompts, the
commands Claude runs, file contents, diffs and more) is collected only while a superadmin has switched it on.
Every switch starts off and applies from the device's next session.

## Who sees it

Only authorized admins (superadmins across all teams, and team leads strictly for their own team). Team leads cannot
see captured content unless a superadmin explicitly turns that permission on in Settings. Teammates don't have
dashboard access, and the monitor shares nothing with anyone else (unless a superadmin connects an internal Slack,
Discord, or webhook channel for operational alerts such as disabled hooks or outside-repo blocks). How long it's kept:

- Captured content, when switched on: deleted after the content retention period (14 days by default).
- Requests, tool and prompt events, prompt labels, Claude Code's counts and Git commits: deleted after the
  retention period set on the server (30 days by default).
- The audit log and admin alerts (a record of admin actions, device joins, prompt label categories, and repository guard events): one year.
- Allowance readings, your device's record (hostname, OS, join IP) and the token fingerprint: no time limit.
  Removing a device stops it reporting but keeps its record; deleting it is done by the admin in the database.

## Always collected

| What | Example | Why |
|---|---|---|
| Allowance readings from the status line | weekly 41%, resets Thu 06:00 | The account-wide meters everyone on that account draws on |
| A one-way SHA-256 hash of the Claude account id that Claude Code attaches to each request (`user.account_uuid`). The id itself, your email and the organization id are dropped on arrival | `5f0c9e…` | Keeping each account's allowance separate when several accounts are in use |
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
| Plugin version and whether a token fingerprint was found, sent at each session start | `plugin-0.5.0` | Spotting outdated or misconfigured devices |
| A **label** for a prompt, decided on your computer (see below), with the session id | `credential-pasted` | Spotting misuse without reading prompts |
| Repository guard events, only when a superadmin turns on warn/block for outside-work or non-repo sessions: hook name, action (`warn` or `block`), reason (`outside_repo` or `no_repo`), normalized git remote, and tool name (for `PreToolUse`). Never file paths, shell commands, or prompt text | `UserPromptSubmit`, `block`, `outside_repo`, `github.com/personal/app` | Enforcing work-repository boundaries on the shared seat |
| Commits in the team's GitLab group and GitHub organization: author email, time, lines added/removed (fetched by the server from GitLab and GitHub, not from your computer) | `rafi@company.com`, +40/−12 | Comparing Claude's output with all output |

## Content the admin can switch on

Each switch is set in the dashboard's Settings. The server only keeps content whose switch is on when the
content arrives. Anything else is dropped, even if a device sends it. Your device applies the current
switches at the start of every session. A change takes effect from the next session, and Claude Code tells
you what changed.

| Switch | What is sent | Example | Where it comes from |
|---|---|---|---|
| Prompt text | The full text of each prompt you send to Claude | "add pagination to the invoices endpoint" | Claude Code telemetry (`OTEL_LOG_USER_PROMPTS`) |
| Commands and tool input | Shell commands Claude runs (full command line), the parameters and input of every tool call, refused tool calls, tool error messages, and the git branch when Claude makes a commit | `git push origin main`, `{"file_path":"src/app.ts"}` | Claude Code telemetry (`OTEL_LOG_TOOL_DETAILS`) |
| File contents and diffs | Paths of files Claude reads, writes or edits; the contents of files Claude reads or writes; edit diffs; command output; what web fetches and searches return (each up to about 60 KB) | `src/app.ts`, a diff, test output | Claude Code beta tracing (`OTEL_LOG_TOOL_CONTENT`). Also turns on the device side of commands and tool input |
| API error messages | The error text when a Claude request fails | `Overloaded` | Claude Code telemetry |
| Commit messages and diffs | The message and diff of every commit in the team's GitLab group and GitHub organization, not only Claude's | "fix login redirect", the diff | Fetched by the server from GitLab and GitHub, not from your computer |

**Secrets.** Before storing any of it, the server replaces anything shaped like a credential with
`[redacted]`: API keys, access tokens (including Claude setup tokens), private keys, passwords in URLs, and
values of settings named like `TOKEN`, `SECRET`, `PASSWORD` or `API_KEY` (`apps/server/src/redact.ts`).
This is pattern matching. A secret in an unusual format can get through, so keep real secrets out of
prompts and out of files Claude reads where you can.

**Not even with every switch on:** Claude's responses (the device explicitly turns them off), full API
request and response bodies, your Claude account email, the raw account or organization ids (only a one-way hash of
the account id is kept), and anything from claude.ai chat, the desktop app or mobile.

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

## Repository guard (optional)

By default the plugin only observes usage and never blocks a session. A superadmin can optionally enable **Repository
guard** in Settings (`warn` or `block` independently for repositories outside the team's approved work namespaces and
for folders with no git repository). When enabled, the plugin checks the session's git remote on your computer at
`UserPromptSubmit` (`plugin/scripts/classify-prompt.sh`) and before file/shell tool runs at `PreToolUse`
(`plugin/scripts/pre-tool-guard.sh`):

- In `warn` (alert admin only) mode, the plugin reports the event silently to the admin without interrupting your session.
- In `block` mode, the hook exits `2` before sending the prompt to Anthropic or running the blocked tool, and prints a
  `usage-monitor:` explanation. Only the hook name, action, reason, normalized remote (if any), and tool name are
  reported to the server (`POST /api/agent/guard`) — never your prompt, file paths, or command arguments.

## Plugin updates

Unless the admin turns it off in Settings, the plugin switches on Claude Code's own auto-update for its marketplace
(`extraKnownMarketplaces.usage-monitor-tools.autoUpdate` in your `~/.claude/settings.json`, pointing at the same
repository you installed from). Claude Code then fetches new plugin versions from that repository in the background
and shows "Plugin updated … run /reload-plugins". Nothing is sent to the monitor for this. Turning the switch off, or
running `uninstall.sh`, removes the entry again.

## Never collected

- Claude's responses
- Full API request and response bodies
- Your Claude account email, and the account or organization ids themselves (the server keeps only a one-way hash of
  the account id, to tell accounts apart)
- Your setup token itself: only its fingerprint, and it's redacted if it appears in captured content
- Anything from claude.ai chat, the desktop app or mobile
- With a switch off: the content that switch covers (the server drops it on arrival)

## What the admin can and can't conclude

With content capture off, the dashboard shows *when*, *where* (which repository), *how much*, and which
prompts got a label, but not *what* you asked. With it on, the admin can also read the prompts, commands,
files and diffs listed above. Neither shows whether the work was good. Its flags (for example "40% of work outside work repositories" or "a lot of
activity between 00:00 and 06:00", "a lot of scripted use", "sessions on two devices at once", or a
prompt label) are prompts for a conversation, not verdicts. Each flag lists its evidence
and the innocent explanations next to it.

## Leaving

Uninstall the plugin (`claude plugin uninstall usage-monitor@usage-monitor-tools`) and your device stops
reporting. To restore your previous settings, ask the admin, or run `sh plugin/scripts/uninstall.sh` from
this repository. Data already sent is kept as described under "Who sees it"; ask the admin to delete it sooner.
