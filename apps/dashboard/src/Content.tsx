// Captured content (prompts, commands, diffs, file reads/writes, errors) and enrolled-team Recent Commits.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { call, type Commit, type ContentItem, type ContentKind, type Overview, type PolicyData } from './lib.ts';
import { Card, PageHead, Pill, SearchBox } from './ui.tsx';

const KIND_LABEL: Record<ContentKind, string> = {
  prompt: 'Prompt', command: 'Command', tool_input: 'Tool input', error: 'Error',
  file_read: 'File read', file_write: 'File written', diff: 'Edit diff', output: 'Command output',
};
const KIND_TONE: Record<ContentKind, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  prompt: 'info', command: 'neutral', tool_input: 'neutral', error: 'bad',
  file_read: 'neutral', file_write: 'good', diff: 'warn', output: 'neutral',
};
const SWITCHES: [keyof PolicyData, string, string][] = [
  ['capturePrompts', 'Prompt text', 'What teammates type to Claude. Claude’s replies are never captured.'],
  ['captureToolDetails', 'Commands and tool input', 'Shell commands Claude runs, tool parameters and input, tool error messages and the git branch.'],
  ['captureFileContent', 'File contents and diffs', 'File paths, contents of files Claude reads or writes, edit diffs and command output. Uses Claude Code’s beta tracing; also sends commands and tool input from the device.'],
  ['captureErrors', 'API error messages', 'The error text when a Claude request fails.'],
  ['captureGitDetails', 'Commit messages and diffs', 'From the GitLab and GitHub commit sync, for enrolled teammates’ commits. Needs GITLAB_TOKEN or GITHUB_TOKEN.'],
];

const timeFmt = (tz: string) => (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso));

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
      className="rounded border border-rule bg-paper px-2 py-0.5 text-xs text-muted hover:text-ink"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Long text starts collapsed; code/diffs render in a clean recessed surface with copy button. */
function TextBlock({ text, mono }: { text: string; mono: boolean }) {
  const long = text.length > 400 || text.split('\n').length > 8;
  const [open, setOpen] = useState(!long);
  return (
    <div className={mono ? 'rounded-md border border-rule bg-paper p-3' : ''}>
      <pre className={`whitespace-pre-wrap break-words ${mono ? 'font-mono text-xs leading-relaxed' : 'font-sans text-sm leading-relaxed'} ${open ? '' : 'line-clamp-4'}`}>
        {text || '(empty)'}
      </pre>
      {long && (
        <button type="button" className="mt-1.5 text-xs font-medium text-muted hover:text-ink" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show full content'}
        </button>
      )}
    </div>
  );
}

export function ContentPage({ data, teamId = '', initial }: {
  data: Overview; teamId?: string; initial: Record<string, string>;
}) {
  const [f, setF] = useState({ q: '', kind: '', personId: initial.personId ?? '', repo: initial.repo ?? '', sessionId: initial.sessionId ?? '' });
  const [rows, setRows] = useState<ContentItem[]>([]);
  const [more, setMore] = useState(false);

  const qs = useMemo(() => {
    const entries: [string, string][] = Object.entries(f).filter(([, v]) => Boolean(v));
    if (teamId) entries.push(['teamId', teamId]);
    return new URLSearchParams(entries).toString();
  }, [f, teamId]);

  const load = useCallback(async (before?: number) => {
    const r = await call<{ items: ContentItem[] }>(`/api/dashboard/content?limit=50&${qs}${before ? `&before=${before}` : ''}`);
    if (!r.data) return;
    setRows((cur) => (before ? [...cur, ...r.data.items] : r.data.items));
    setMore(r.data.items.length === 50);
  }, [qs]);

  useEffect(() => { const t = setTimeout(() => load(), 180); return () => clearTimeout(t); }, [load]);

  const p = data.policy.data;
  const on = SWITCHES.filter(([k]) => p[k]).map(([, l]) => (/^[A-Z]{2}/.test(l) ? l : l[0].toLowerCase() + l.slice(1)));
  const time = timeFmt(p.displayTimezone);
  const field = 'rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm';

  return (
    <div className="space-y-6">
      <PageHead
        title="Captured content"
        sub={on.length
          ? `Capturing ${on.join(', ')}. Secrets are redacted on arrival. Kept ${p.contentRetentionDays} days.`
          : 'Content capture is off. Enable specific switches in Settings to collect prompts, commands or diffs.'}
        action={
          <button type="button" className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band" onClick={() => load()}>
            Refresh
          </button>
        }
      />

      <div className="rounded-xl border border-rule bg-card p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchBox value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Search text and file paths" />
          <select aria-label="Person" className={field} value={f.personId} onChange={(e) => setF({ ...f, personId: e.target.value })}>
            <option value="">Everyone</option>
            {data.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <select aria-label="Kind" className={field} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="">All kinds</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {f.repo && (
            <button type="button" onClick={() => setF({ ...f, repo: '' })}
              className="inline-flex items-center gap-1.5 rounded-full border border-ink bg-ink px-2.5 py-1 text-xs text-paper">
              <span className="font-mono">{f.repo}</span>
              <span aria-hidden>×</span>
            </button>
          )}
          {f.sessionId && (
            <button type="button" onClick={() => setF({ ...f, sessionId: '' })}
              className="inline-flex items-center gap-1.5 rounded-full border border-ink bg-ink px-2.5 py-1 text-xs text-paper">
              <span>Session <code className="font-mono">{f.sessionId.slice(0, 12)}</code></span>
              <span aria-hidden>×</span>
            </button>
          )}
          {Object.values(f).some(Boolean) && (
            <button type="button" className="text-sm text-muted hover:text-ink" onClick={() => setF({ q: '', kind: '', personId: '', repo: '', sessionId: '' })}>
              Clear
            </button>
          )}
        </div>
      </div>

      <Card>
        <ol className="space-y-3">
          {rows.map((r) => {
            const isCode = r.kind !== 'prompt' && r.kind !== 'error';
            return (
              <li key={r.id} className="rounded-lg border border-rule bg-card p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
                    <Pill tone={KIND_TONE[r.kind] ?? 'neutral'}>{KIND_LABEL[r.kind] ?? r.kind}</Pill>
                    <span className="font-mono">{time(r.eventTime)}</span>
                    <span className="font-medium text-ink">{r.person ?? 'Unassigned'}</span>
                    <span>on {r.device}</span>
                    {r.toolName && <Pill tone="neutral">{r.toolName}</Pill>}
                    {r.repo && (
                      <button type="button" className="font-mono hover:text-ink hover:underline" onClick={() => setF({ ...f, repo: r.repo! })}>
                        {r.repo}
                      </button>
                    )}
                    {r.branch && <span>branch {r.branch}</span>}
                    {r.sessionId && (
                      <button type="button" className="hover:text-ink hover:underline" onClick={() => setF({ ...f, sessionId: r.sessionId! })}>
                        Session <code className="font-mono">{r.sessionId.slice(0, 10)}</code>
                      </button>
                    )}
                    {r.truncated && <Pill tone="warn">truncated</Pill>}
                  </div>
                  {r.text && <CopyButton text={r.text} />}
                </div>
                {r.filePath && <p className="mb-2 break-all font-mono text-xs text-muted">{r.filePath}</p>}
                {(r.text || !r.filePath) && <TextBlock text={r.text} mono={isCode} />}
              </li>
            );
          })}
        </ol>
        {!rows.length && (
          <p className="py-8 text-center text-sm text-muted">
            {on.length ? 'Nothing matches the current filters.' : 'Nothing captured while capture switches are off.'}
          </p>
        )}
        {more && (
          <div className="mt-4 text-center">
            <button type="button" className="rounded-md border border-rule bg-card px-4 py-1.5 text-sm hover:bg-band" onClick={() => load(rows[rows.length - 1].id)}>
              Load older items
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

export function CaptureSettings({ policy, onDone }: { policy: PolicyData; onDone: () => void }) {
  const [v, setV] = useState(() => Object.fromEntries(SWITCHES.map(([k]) => [k, Boolean(policy[k])])) as Record<string, boolean>);
  const [days, setDays] = useState(String(policy.contentRetentionDays));
  const [leadsContent, setLeadsContent] = useState(policy.leadsCanViewContent);
  const [msg, setMsg] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/policy', 'PATCH', {
      ...v,
      contentRetentionDays: Number(days),
      leadsCanViewContent: leadsContent,
    });
    setMsg(r.status === 200 ? `Saved as policy revision ${r.data.revision}. Each device applies it at its next session.` : 'Not saved: keep content for 1 to 365 days.');
    if (r.status === 200) onDone();
  };
  return (
    <form onSubmit={save} className="space-y-3">
      {SWITCHES.map(([k, label, desc]) => (
        <label key={k} className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--fill)]" checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />
          <span><span className="font-medium">{label}</span><span className="block text-muted">{desc}</span></span>
        </label>
      ))}
      <div className="border-t border-rule pt-3">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--fill)]" checked={leadsContent} onChange={(e) => setLeadsContent(e.target.checked)} />
          <span>
            <span className="font-medium">Allow team leads to read captured content</span>
            <span className="block text-muted">Off by default. When on, team leads can inspect prompts, commands and diffs for their own team only.</span>
          </span>
        </label>
      </div>
      <label className="flex flex-col gap-1 pt-1 text-sm">Keep captured content (days)
        <input className="w-28 rounded-md border border-rule bg-paper px-3 py-1.5" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Save capture settings</button>
      <p className="text-sm text-muted">{msg || 'Secrets are redacted on arrival. See TRANSPARENCY.md for each switch.'}</p>
    </form>
  );
}

/** Recent commits strictly scoped to enrolled teammates (INNER JOIN people). */
export function RecentCommits({ tz, range, teamId = '', people = [] }: {
  tz: string; range?: string; teamId?: string; people?: { id: number; name: string }[];
}) {
  const [personId, setPersonId] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [rows, setRows] = useState<Commit[]>([]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (range) params.set('range', range);
    if (teamId) params.set('teamId', teamId);
    if (personId) params.set('personId', personId);
    if (repoFilter) params.set('repo', repoFilter);
    call<{ commits: Commit[] }>(`/api/dashboard/commits?${params.toString()}`).then((r) => {
      if (r.status === 200 && r.data) setRows(r.data.commits);
    });
  }, [range, teamId, personId, repoFilter]);

  const time = timeFmt(tz);
  const repos = useMemo(() => [...new Set(rows.map((r) => r.repo))].sort(), [rows]);
  const field = 'rounded-md border border-rule bg-card px-2.5 py-1.5 text-xs';

  return (
    <Card
      title="Recent team commits"
      sub="Enrolled teammates only. Unmapped org pushes are excluded until mapped to a teammate."
      action={
        <div className="flex flex-wrap gap-2">
          {people.length > 0 && (
            <select aria-label="Filter commits by person" className={field} value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">All enrolled teammates</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {repos.length > 1 && (
            <select aria-label="Filter commits by repository" className={field} value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
              <option value="">All repositories</option>
              {repos.map((rp) => <option key={rp} value={rp}>{rp}</option>)}
            </select>
          )}
        </div>
      }
    >
      <ol className="divide-y divide-rule">
        {rows.map((c) => (
          <li key={c.repo + c.sha} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="font-medium text-ink">{c.person ?? c.authorEmail}</span>
                <span className="font-mono">{c.repo}</span>
                <span className="rounded bg-band px-1.5 py-0.5 font-mono">{c.sha.slice(0, 8)}</span>
                <span className="tabular-nums">+{c.additions} / -{c.deletions}</span>
              </div>
              <span className="font-mono">{time(c.committedAt)}</span>
            </div>
            {c.message ? (
              <div className="mt-1.5"><TextBlock text={c.message} mono={false} /></div>
            ) : (
              <p className="mt-1 text-xs text-muted">Commit message not captured (enable commit details in Settings).</p>
            )}
            {c.diff && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">Show diff</summary>
                <div className="mt-2">
                  <div className="mb-1 flex justify-end"><CopyButton text={c.diff} /></div>
                  <TextBlock text={c.diff} mono />
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
      {!rows.length && <p className="py-6 text-center text-sm text-muted">No synced commits from enrolled teammates in this range.</p>}
    </Card>
  );
}
