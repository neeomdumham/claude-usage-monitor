// Content the owner switched on in Settings: prompts, commands, file contents, diffs, errors, commit messages.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { call, type Commit, type ContentItem, type ContentKind, type Overview, type PolicyData } from './lib.ts';
import { Card, PageHead, SearchBox } from './ui.tsx';

const KIND_LABEL: Record<ContentKind, string> = {
  prompt: 'Prompt', command: 'Command', tool_input: 'Tool input', error: 'Error',
  file_read: 'File read', file_write: 'File written', diff: 'Edit diff', output: 'Command output',
};
const SWITCHES: [keyof PolicyData, string, string][] = [
  ['capturePrompts', 'Prompt text', 'What teammates type to Claude. Claude’s replies are never captured.'],
  ['captureToolDetails', 'Commands and tool input', 'Shell commands Claude runs, tool parameters and input, tool error messages and the git branch.'],
  ['captureFileContent', 'File contents and diffs', 'File paths, contents of files Claude reads or writes, edit diffs and command output. Uses Claude Code’s beta tracing; also sends commands and tool input from the device.'],
  ['captureErrors', 'API error messages', 'The error text when a Claude request fails.'],
  ['captureGitDetails', 'Commit messages and diffs', 'From the GitLab and GitHub commit sync, for every commit (not only Claude’s). Needs GITLAB_TOKEN or GITHUB_TOKEN.'],
];

const timeFmt = (tz: string) => (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso));

/** Long text starts collapsed; the owner opens what they need. */
function Text({ text, mono }: { text: string; mono: boolean }) {
  const long = text.length > 400 || text.split('\n').length > 8;
  const [open, setOpen] = useState(!long);
  return (
    <div>
      <pre className={`whitespace-pre-wrap break-words ${mono ? 'font-mono text-xs' : 'font-sans text-sm'} ${open ? '' : 'line-clamp-4'}`}>{text || '(empty)'}</pre>
      {long && <button className="mt-1 text-xs text-muted hover:text-ink" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show all'}</button>}
    </div>
  );
}

export function ContentPage({ data, initial }: { data: Overview; initial: Record<string, string> }) {
  const [f, setF] = useState({ q: '', kind: '', personId: initial.personId ?? '', repo: '' });
  const [rows, setRows] = useState<ContentItem[]>([]);
  const [more, setMore] = useState(false);
  const qs = useMemo(() => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString(), [f]);
  const load = useCallback(async (before?: number) => {
    const r = await call<{ items: ContentItem[] }>(`/api/dashboard/content?limit=50&${qs}${before ? `&before=${before}` : ''}`);
    if (!r.data) return;
    setRows((cur) => (before ? [...cur, ...r.data.items] : r.data.items));
    setMore(r.data.items.length === 50);
  }, [qs]);
  useEffect(() => { const t = setTimeout(() => load(), 200); return () => clearTimeout(t); }, [load]);
  const p = data.policy.data;
  const on = SWITCHES.filter(([k]) => p[k]).map(([, l]) => (/^[A-Z]{2}/.test(l) ? l : l[0].toLowerCase() + l.slice(1)));
  const time = timeFmt(p.displayTimezone);
  const field = 'rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm';

  return (
    <div>
      <PageHead title="Captured content"
        sub={on.length ? `Capturing ${on.join(', ')}. Secrets are redacted on arrival. Kept ${p.contentRetentionDays} days.`
          : 'Content capture is off. Turn it on in Settings; teammates are told on their next session.'}
        action={<button className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band" onClick={() => load()}>Refresh</button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchBox value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Search text and file paths" />
        <select aria-label="Person" className={field} value={f.personId} onChange={(e) => setF({ ...f, personId: e.target.value })}>
          <option value="">Everyone</option>
          {data.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select aria-label="Kind" className={field} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="">All kinds</option>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {Object.values(f).some(Boolean) && <button className="text-sm text-muted hover:text-ink" onClick={() => setF({ q: '', kind: '', personId: '', repo: '' })}>Clear</button>}
      </div>
      <Card>
        <ol className="divide-y divide-rule">
          {rows.map((r) => (
            <li key={r.id} className="py-3">
              <p className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                <span className="rounded bg-band px-1.5 py-0.5 font-medium text-ink">{KIND_LABEL[r.kind] ?? r.kind}</span>
                <span className="font-mono">{time(r.eventTime)}</span>
                <span>{r.person ?? 'Unassigned'} on {r.device}</span>
                {r.toolName && <span>{r.toolName}</span>}
                {r.repo && <button className="hover:text-ink" onClick={() => setF({ ...f, repo: r.repo! })}>{r.repo}</button>}
                {r.branch && <span>branch {r.branch}</span>}
                {r.truncated && <span>truncated</span>}
              </p>
              {r.filePath && <p className="mb-1 break-all font-mono text-xs">{r.filePath}</p>}
              {(r.text || !r.filePath) && <Text text={r.text} mono={r.kind !== 'prompt' && r.kind !== 'error'} />}
            </li>
          ))}
        </ol>
        {!rows.length && <p className="py-6 text-center text-sm text-muted">{on.length ? 'Nothing captured yet. Devices start sending after their next session.' : 'Nothing captured.'}</p>}
        {more && <button className="mt-4 text-sm text-muted hover:text-ink" onClick={() => load(rows[rows.length - 1].id)}>Load older</button>}
      </Card>
    </div>
  );
}

export function CaptureSettings({ policy, onDone }: { policy: PolicyData; onDone: () => void }) {
  const [v, setV] = useState(() => Object.fromEntries(SWITCHES.map(([k]) => [k, Boolean(policy[k])])) as Record<string, boolean>);
  const [days, setDays] = useState(String(policy.contentRetentionDays));
  const [msg, setMsg] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/policy', 'PATCH', { ...v, contentRetentionDays: Number(days) });
    setMsg(r.status === 200 ? `Saved as policy revision ${r.data.revision}. Each device applies it, and tells its user, at its next session.` : 'Not saved: keep content for 1 to 365 days.');
    if (r.status === 200) onDone();
  };
  return (
    <form onSubmit={save} className="space-y-3">
      {SWITCHES.map(([k, label, desc]) => (
        <label key={k} className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--ink)]" checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />
          <span><span className="font-medium">{label}</span><span className="block text-muted">{desc}</span></span>
        </label>
      ))}
      <label className="flex flex-col gap-1 text-sm">Keep captured content (days)
        <input className="w-28 rounded-md border border-rule bg-paper px-3 py-1.5" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Save capture settings</button>
      <p className="text-sm text-muted">{msg || 'Teammates see a notice naming exactly what is captured whenever this changes. TRANSPARENCY.md describes each switch.'}</p>
    </form>
  );
}

/** Recent GitLab commits with message and diff; shown on the Git page while git details capture is on. */
export function RecentCommits({ tz }: { tz: string }) {
  const [rows, setRows] = useState<Commit[]>([]);
  useEffect(() => { call<{ commits: Commit[] }>('/api/dashboard/commits').then((r) => r.data && setRows(r.data.commits)); }, []);
  const time = timeFmt(tz);
  return (
    <Card title="Recent commits" sub="Messages and diffs from the GitLab sync, newest first.">
      <ol className="divide-y divide-rule">
        {rows.map((c) => (
          <li key={c.repo + c.sha} className="py-3">
            <p className="mb-1 flex flex-wrap gap-x-3 text-xs text-muted">
              <span className="font-mono">{time(c.committedAt)}</span><span>{c.person ?? c.authorEmail}</span><span>{c.repo}</span>
              <span className="font-mono">{c.sha.slice(0, 8)}</span><span>+{c.additions} / −{c.deletions}</span>
            </p>
            <Text text={c.message ?? '(message not captured)'} mono={false} />
            {c.diff && <details className="mt-1"><summary className="cursor-pointer text-xs text-muted hover:text-ink">Diff</summary><Text text={c.diff} mono /></details>}
          </li>
        ))}
      </ol>
      {!rows.length && <p className="py-6 text-center text-sm text-muted">No commits synced yet.</p>}
    </Card>
  );
}
