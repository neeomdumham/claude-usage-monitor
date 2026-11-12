import { useMemo, useState, type ReactNode } from 'react';
import { HourHeatmap, StackedBars, Stat, type Series } from './charts.tsx';
import { call, compact, daysBetween, pct, personColors, usd, type Analytics as A, type Person, type PersonStats, type PolicyData } from './lib.ts';

const h2 = 'text-2xl font-semibold';
const sub = 'mt-1 max-w-[66ch] text-sm text-muted';

export function useColors(a: A) {
  return useMemo(() => personColors(a.people.map((p) => p.pid)), [a]);
}
const nameOf = (a: A, pid: number | null) => (pid === null ? 'Not matched to anyone' : a.people.find((p) => p.pid === pid)?.name ?? `#${pid}`);

type Col = { key: string; label: string; value: (p: PersonStats) => number | string; show?: (p: PersonStats) => ReactNode; over?: (p: PersonStats) => boolean; num?: boolean };

/** Every person side by side. Alphabetical by default: this is a comparison, not a leaderboard. */
export function PeopleTable({ a, policy, onOpen }: { a: A; policy: PolicyData; onOpen: (pid: number) => void }) {
  const color = useColors(a);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const total = a.people.reduce((s, p) => s + p.cost, 0);
  const share = (p: PersonStats, k: 'outside' | 'none') => pct(p.repoCost[k], p.repoCost.work + p.repoCost.outside + p.repoCost.none);
  const flagCount = (p: PersonStats) => a.flags.filter((f) => f.pid === p.pid).length;
  const cols: Col[] = [
    { key: 'cost', label: 'Cost', value: (p) => p.cost, show: (p) => usd(p.cost), num: true },
    { key: 'share', label: 'Share', value: (p) => pct(p.cost, total), show: (p) => `${pct(p.cost, total)}%`, num: true },
    { key: 'requests', label: 'Requests', value: (p) => p.requests, show: (p) => p.requests.toLocaleString(), num: true },
    { key: 'sessions', label: 'Sessions', value: (p) => p.sessions, num: true },
    { key: 'days', label: 'Active days', value: (p) => p.activeDays, num: true },
    { key: 'outside', label: 'Outside work', value: (p) => share(p, 'outside'), show: (p) => `${share(p, 'outside')}%`, over: (p) => policy.workNamespaces.length > 0 && share(p, 'outside') >= policy.flagOutsideWorkPct, num: true },
    { key: 'norepo', label: 'No repo', value: (p) => share(p, 'none'), show: (p) => `${share(p, 'none')}%`, over: (p) => share(p, 'none') >= policy.flagNoRepoPct, num: true },
    { key: 'night', label: '00–06h', value: (p) => p.nightPct, show: (p) => `${p.nightPct}%`, over: (p) => p.requests >= 20 && p.nightPct >= policy.flagNightPct, num: true },
    { key: 'sdk', label: 'Scripted', value: (p) => p.sdkPct, show: (p) => `${p.sdkPct}%`, over: (p) => p.requests >= 50 && p.sdkPct >= policy.flagSdkPct, num: true },
    { key: 'bypass', label: 'Bypass', value: (p) => p.bypassPct, show: (p) => `${p.bypassPct}%`, over: (p) => p.decisions >= 20 && p.bypassPct >= policy.flagBypassPct, num: true },
    { key: 'cache', label: 'Cache hit', value: (p) => p.cacheHit, show: (p) => `${Math.round(p.cacheHit * 100)}%`, num: true },
    { key: 'commits', label: 'Claude commits', value: (p) => p.claude.commits, num: true },
    { key: 'all', label: 'All commits', value: (p) => p.gitlab.commits, num: true },
    { key: 'model', label: 'Top model', value: (p) => p.topModel ?? '' },
    { key: 'flags', label: 'Flags', value: flagCount, show: (p) => flagCount(p) || '', over: (p) => flagCount(p) > 0, num: true },
  ];
  const rows = [...a.people].sort((x, y) => {
    const c = cols.find((c) => c.key === sort.key);
    const vx = c ? c.value(x) : x.name.toLowerCase(), vy = c ? c.value(y) : y.name.toLowerCase();
    return (vx < vy ? -1 : vx > vy ? 1 : 0) * sort.dir;
  });
  const th = (key: string, label: string, num?: boolean) => (
    <th key={key} scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      className={`whitespace-nowrap px-2 py-2 font-normal ${num ? 'text-right' : 'text-left'}`}>
      <button className={`hover:text-ink ${sort.key === key ? 'font-medium text-ink' : ''}`}
        onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 })}>
        {label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
  return (
    <section>
      <h2 className={h2}>People compared</h2>
      <p className={sub}>Highlighted cells cross a threshold you set in Settings. Click a name for their full profile.</p>
      {/* relative: keeps the sr-only threshold labels inside the scroll box instead of widening the page */}
      <div className="relative mt-6 overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="border-b border-rule text-muted"><tr>{th('name', 'Person')}{cols.map((c) => th(c.key, c.label, c.num))}</tr></thead>
          <tbody className="divide-y divide-rule">
            {rows.map((p) => (
              <tr key={p.pid}>
                <th scope="row" className="whitespace-nowrap px-2 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: color(p.pid) }} aria-hidden />
                    {p.isPerson ? <button className="underline decoration-rule underline-offset-4 hover:decoration-ink" onClick={() => onOpen(p.pid)}>{p.name}</button> : p.name}
                  </span>
                </th>
                {cols.map((c) => {
                  const over = c.over?.(p);
                  return (
                    <td key={c.key} className={`whitespace-nowrap px-2 py-2.5 ${c.num ? 'text-right' : ''} ${over ? 'bg-band font-semibold text-ahead' : ''}`}>
                      {over && <span className="sr-only">Above threshold: </span>}
                      {c.show ? c.show(p) : String(c.value(p))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Repositories({ a }: { a: A }) {
  const color = useColors(a);
  const top = a.repos.slice(0, 12);
  const people = a.people.filter((p) => p.requests > 0);
  const maxCell = Math.max(1e-9, ...top.flatMap((r) => r.people.map((x) => x.cost)));
  const name = (r: A['repos'][number]) => r.repo ?? 'No repository';
  return (
    <div className="space-y-14">
      <section>
        <h2 className={h2}>Repositories</h2>
        <p className={sub}>Where the work happened. "All commits" comes from your GitLab group, "Claude commits" from Claude Code itself.</p>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-b border-rule text-left text-muted">
              <tr>{['Repository', 'Cost', 'Requests', 'Sessions', 'People', 'Claude commits', 'All commits', 'Claude lines +/−', 'All lines +/−'].map((h, i) => (
                <th key={h} scope="col" className={`whitespace-nowrap px-2 py-2 font-normal ${i ? 'text-right' : ''}`}>{h}</th>))}</tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {a.repos.map((r) => (
                <tr key={name(r)}>
                  <th scope="row" className="px-2 py-2.5 text-left font-medium">
                    {r.repo ?? <span className="text-muted">No repository</span>}
                    {r.class === 'outside' && <span className="ml-2 text-xs font-normal text-ahead">outside work</span>}
                  </th>
                  <td className="px-2 text-right">{usd(r.cost)}</td>
                  <td className="px-2 text-right">{r.requests.toLocaleString()}</td>
                  <td className="px-2 text-right">{r.sessions}</td>
                  <td className="px-2 text-right">
                    <span className="inline-flex gap-1">{r.people.map((x) => (
                      <span key={x.pid} title={nameOf(a, x.pid)} className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: color(x.pid) }} />
                    ))}</span>
                  </td>
                  <td className="px-2 text-right">{r.claude.commits || ''}</td>
                  <td className="px-2 text-right">{r.gitlab.commits || ''}</td>
                  <td className="px-2 text-right">{r.claude.added || r.claude.removed ? `+${compact(r.claude.added)} / −${compact(r.claude.removed)}` : ''}</td>
                  <td className="px-2 text-right">{r.gitlab.additions || r.gitlab.deletions ? `+${compact(r.gitlab.additions)} / −${compact(r.gitlab.deletions)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!a.repos.length && <p className="mt-4 text-sm text-muted">No activity in this range.</p>}
        </div>
      </section>

      {people.length > 0 && top.length > 0 && (
        <section>
          <h2 className={h2}>Who works where</h2>
          <p className={sub}>Cost per person and repository. Stronger colour is more.</p>
          <div className="mt-6 overflow-x-auto">
            <table className="border-separate border-spacing-[3px] text-sm">
              <thead><tr><th />{people.map((p) => <th key={p.pid} scope="col" className="px-2 text-left font-normal text-muted">{p.name}</th>)}</tr></thead>
              <tbody>
                {top.map((r) => (
                  <tr key={name(r)}>
                    <th scope="row" className="max-w-[18rem] truncate pr-3 text-left font-normal">{name(r)}</th>
                    {people.map((p) => {
                      const v = r.people.find((x) => x.pid === p.pid)?.cost ?? 0;
                      return (
                        <td key={p.pid} className="h-8 min-w-16 rounded-[2px] px-2 text-right text-xs" aria-label={`${p.name} in ${name(r)}: ${usd(v)}`}
                          style={{ background: v ? `color-mix(in oklab, var(--fill) ${Math.min(100, Math.round(15 + (85 * v) / maxCell))}%, var(--track))` : 'var(--track)', color: v / maxCell > 0.5 ? 'var(--paper)' : undefined }}>
                          {v ? usd(v) : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

/** One row per person, one column per key (permission mode, entrypoint, ...), as % of that person's total. */
function SplitTable({ a, rows, title, note, highlight, counts }: { a: A; rows: { pid: number; key: string; n: number }[]; title: string; note: string; highlight?: string; counts?: boolean }) {
  const keys = [...new Set(rows.map((r) => r.key))].sort();
  const pids = [...new Set(rows.map((r) => r.pid))];
  if (!rows.length) return <section><h3 className="text-lg font-semibold">{title}</h3><p className="mt-1 text-sm text-muted">Nothing reported in this range.</p></section>;
  return (
    <section className="min-w-0">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{note}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="border-b border-rule text-muted"><tr><th className="py-1.5 text-left font-normal">Person</th>
            {keys.map((k) => <th key={k} scope="col" className="px-2 text-right font-normal">{k}</th>)}</tr></thead>
          <tbody className="divide-y divide-rule">
            {pids.map((pid) => {
              const mine = rows.filter((r) => r.pid === pid);
              const total = mine.reduce((s, r) => s + r.n, 0);
              return (
                <tr key={pid}>
                  <th scope="row" className="py-2 text-left font-medium">{nameOf(a, pid)}</th>
                  {keys.map((k) => {
                    const n = mine.find((r) => r.key === k)?.n ?? 0;
                    const hot = k === highlight && n > 0;
                    return <td key={k} className={`px-2 text-right ${hot ? 'font-semibold text-ahead' : ''}`}>{n ? (counts ? n : `${pct(n, total)}%`) : ''}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Activity({ a }: { a: A }) {
  const labelRows = a.people.flatMap((p) => Object.entries(p.labels).map(([key, n]) => ({ pid: p.pid, key, n })));
  return (
    <div className="space-y-14">
      <section>
        <h2 className={h2}>When the team works</h2>
        <div className="mt-4"><HourHeatmap cells={a.activity.heatmap} tz={a.timezone} /></div>
      </section>

      <section>
        <h2 className={h2}>Tools</h2>
        <p className={sub}>What Claude did on everyone's behalf. Durations are per call.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-b border-rule text-muted"><tr>
              {['Tool', 'Calls', 'Failed', 'Typical', 'Slowest 5%'].map((h, i) => <th key={h} scope="col" className={`px-2 py-2 font-normal ${i ? 'text-right' : 'text-left'}`}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-rule">
              {a.activity.tools.map((t) => (
                <tr key={t.tool}>
                  <th scope="row" className="px-2 py-2 text-left font-medium">{t.tool}</th>
                  <td className="px-2 text-right">{t.calls.toLocaleString()}</td>
                  <td className="px-2 text-right">{t.failures ? `${pct(t.failures, t.calls)}%` : ''}</td>
                  <td className="px-2 text-right">{t.p50 === null ? '' : `${(t.p50 / 1000).toFixed(1)} s`}</td>
                  <td className="px-2 text-right">{t.p95 === null ? '' : `${(t.p95 / 1000).toFixed(1)} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!a.activity.tools.length && <p className="mt-3 text-sm text-muted">No tool calls in this range.</p>}
        </div>
      </section>

      <div className="grid gap-12 lg:grid-cols-2">
        <SplitTable a={a} rows={a.activity.permissionModes} title="Permission mode" note="Share of tool decisions made in each mode." highlight="bypassPermissions" />
        <SplitTable a={a} rows={a.activity.entrypoints} title="How Claude Code was started" note="cli is interactive; sdk-* is scripts, CI or other tools." />
        <SplitTable a={a} rows={a.activity.querySources} title="Who made the requests" note="Main conversation vs subagents and other internal calls." />
        <SplitTable a={a} rows={labelRows} title="Prompt labels" note="Prompts labelled on each laptop by keyword; only the label reaches the server. The teammate sees a notice each time." highlight="credential-pasted" counts />
      </div>

      <div className="grid gap-12 sm:grid-cols-2">
        <section>
          <h3 className="text-lg font-semibold">Subagents</h3>
          <ul className="mt-2 divide-y divide-rule text-sm">
            {a.activity.subagents.map((s) => <li key={s.agent} className="flex justify-between py-1.5"><span>{s.agent}</span><span className="text-muted">{s.n} runs</span></li>)}
            {!a.activity.subagents.length && <li className="py-1.5 text-muted">None.</li>}
          </ul>
        </section>
        <section>
          <h3 className="text-lg font-semibold">API errors</h3>
          <ul className="mt-2 divide-y divide-rule text-sm">
            {a.activity.errors.map((e) => <li key={e.status} className="flex justify-between py-1.5"><span>Status {e.status}</span><span className="text-muted">{e.n}</span></li>)}
            {!a.activity.errors.length && <li className="py-1.5 text-muted">None.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

export function Git({ a, team, onChange }: { a: A; team: Person[]; onChange: () => void }) {
  const color = useColors(a);
  const gl = a.git.gitlabConfigured;
  const [msg, setMsg] = useState('');
  const days = daysBetween(a.range.start, a.range.end, a.timezone);
  const claude = a.people.reduce((s, p) => s + p.claude.commits, 0);
  const prs = a.people.reduce((s, p) => s + p.claude.prs, 0);
  const added = a.people.reduce((s, p) => s + p.claude.added, 0);
  const removed = a.people.reduce((s, p) => s + p.claude.removed, 0);
  const all = a.git.gitlabDaily.reduce((s, d) => s + d.commits, 0);
  const cost = a.people.reduce((s, p) => s + p.cost, 0);
  const acc = a.git.edits.reduce((s, e) => s + e.accepted, 0), rej = a.git.edits.reduce((s, e) => s + e.rejected, 0);
  const pids = [...new Set(a.git.gitlabDaily.map((d) => d.pid))];
  const allSeries: Series[] = pids.map((pid) => ({
    id: String(pid), label: nameOf(a, pid), color: pid === null ? 'var(--muted)' : color(pid),
    values: days.map((d) => a.git.gitlabDaily.find((x) => x.day === d && x.pid === pid)?.commits ?? 0),
  }));
  const claudeSeries: Series[] = [...new Set(a.git.claudeDaily.map((d) => d.pid))].map((pid) => ({
    id: String(pid), label: nameOf(a, pid), color: color(pid),
    values: days.map((d) => a.git.claudeDaily.find((x) => x.day === d && x.pid === pid)?.commits ?? 0),
  }));
  const sync = async () => {
    setMsg('Syncing…');
    const r = await call('/api/dashboard/git/sync', 'POST');
    setMsg(r.status === 200 ? `Synced ${r.data.projects} projects, ${r.data.commits} new commits.` : r.data?.error ?? 'Sync failed.');
    onChange();
  };
  const assign = async (email: string, pid: number) => {
    const person = team.find((p) => p.id === pid);
    if (person) await call(`/api/dashboard/people/${pid}/git-emails`, 'PUT', { emails: [...person.gitEmails, email] });
    onChange();
  };

  return (
    <div className="space-y-14">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className={h2}>Git output</h2>
            <p className={sub}>
              Claude numbers come from Claude Code and count only what Claude itself committed or edited, so they run low.
              All commits come from your GitLab group.
            </p>
          </div>
          {a.git.gitlabConfigured && (
            <div className="text-right text-sm">
              <button className="rounded-md bg-ink px-3 py-1.5 font-medium text-paper" onClick={sync}>Sync GitLab now</button>
              <p className="mt-1 text-muted">{msg || (a.git.lastSync ? `Last synced ${new Date(a.git.lastSync).toLocaleString()}` : 'Not synced yet')}</p>
            </div>
          )}
        </div>
        {!a.git.gitlabConfigured && (
          <p className="mt-4 rounded-lg bg-band px-5 py-4 text-sm">
            To count every commit, not just Claude's, set <code>GITLAB_TOKEN</code> (read_api) and <code>GITLAB_GROUP</code> in the server's
            <code> .env</code> and restart it. Then map each teammate's commit email in Team.
          </p>
        )}
        <div className="mt-8 flex flex-wrap gap-x-10 gap-y-6">
          <Stat label="Claude commits" value={String(claude)} />
          <Stat label="Claude PRs / MRs" value={String(prs)} />
          <Stat label="Lines Claude wrote" value={`+${compact(added)}`} note={`−${compact(removed)} removed`} />
          <Stat label="All commits" value={a.git.gitlabConfigured ? String(all) : '—'} note={a.git.gitlabConfigured && all ? `${Math.min(100, pct(claude, all))}% by Claude` : undefined} />
          <Stat label="Cost per Claude commit" value={claude ? usd(cost / claude) : '—'} note="Exploration counts too" />
          <Stat label="Edits accepted" value={acc + rej ? `${pct(acc, acc + rej)}%` : '—'} />
        </div>
      </section>

      {a.git.gitlabConfigured && (
        <section>
          <h3 className="text-lg font-semibold">All commits by day</h3>
          <div className="mt-4">{all ? <StackedBars label="All commits by day" days={days} series={allSeries} format={(n) => String(Math.round(n))} height={200} /> : <p className="text-sm text-muted">No commits in this range.</p>}</div>
        </section>
      )}
      <section>
        <h3 className="text-lg font-semibold">Commits Claude made, by day</h3>
        <div className="mt-4">{claude ? <StackedBars label="Claude commits by day" days={days} series={claudeSeries} format={(n) => String(Math.round(n))} height={200} /> : <p className="text-sm text-muted">No commits by Claude in this range.</p>}</div>
      </section>

      <section>
        <h3 className="text-lg font-semibold">By person</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-b border-rule text-muted"><tr>
              {['Person', 'Claude commits', 'PRs', 'Claude lines', ...(gl ? ['All commits', 'All lines', 'Claude share'] : []), 'Hands-on time', 'Claude working time'].map((h, i) => (
                <th key={h} scope="col" className={`px-2 py-2 font-normal ${i ? 'text-right' : 'text-left'}`}>{h}</th>))}
            </tr></thead>
            <tbody className="divide-y divide-rule">
              {a.people.map((p) => (
                <tr key={p.pid}>
                  <th scope="row" className="px-2 py-2 text-left font-medium">{p.name}</th>
                  <td className="px-2 text-right">{p.claude.commits}</td>
                  <td className="px-2 text-right">{p.claude.prs}</td>
                  <td className="px-2 text-right">+{compact(p.claude.added)} / −{compact(p.claude.removed)}</td>
                  {gl && <>
                    <td className="px-2 text-right">{p.gitlab.commits}</td>
                    <td className="px-2 text-right">+{compact(p.gitlab.additions)} / −{compact(p.gitlab.deletions)}</td>
                    {/* Claude can also commit in repos outside the synced group, so the ratio is capped. */}
                    <td className="px-2 text-right" title="Claude commits as a share of all commits in your GitLab group">{p.gitlab.commits ? `${Math.min(100, pct(p.claude.commits, p.gitlab.commits))}%` : ''}</td>
                  </>}
                  <td className="px-2 text-right">{(p.claude.activeUserSec / 3600).toFixed(1)} h</td>
                  <td className="px-2 text-right">{(p.claude.activeCliSec / 3600).toFixed(1)} h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {a.git.unmappedAuthors.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold">Commit authors not matched to anyone</h3>
          <p className="mt-1 text-sm text-muted">Assign an email to a teammate so their commits count under their name.</p>
          <ul className="mt-3 divide-y divide-rule text-sm">
            {a.git.unmappedAuthors.map((u) => (
              <li key={u.email} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span>{u.email} <span className="text-muted">({u.commits} commit{u.commits === 1 ? '' : 's'})</span></span>
                <select aria-label={`Assign ${u.email}`} className="rounded-md border border-rule bg-paper px-2 py-1" defaultValue=""
                  onChange={(e) => e.target.value && assign(u.email, Number(e.target.value))}>
                  <option value="">Assign to…</option>
                  {a.people.filter((p) => p.isPerson).map((p) => <option key={p.pid} value={p.pid}>{p.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
