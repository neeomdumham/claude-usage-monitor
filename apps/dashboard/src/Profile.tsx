import { useEffect, useState } from 'react';
import { HourHeatmap } from './charts.tsx';
import { call, compact, type Profile as P } from './lib.ts';

const CLASS_LABEL = { work: 'Work repositories', outside: 'Outside work repositories', none: 'No repository' };
const usd = (n: number) => `$${n.toFixed(2)}`;

export function Profile({ personId, onBack }: { personId: number; onBack: () => void }) {
  const [p, setP] = useState<P | null>(null);
  useEffect(() => { call<P>(`/api/dashboard/people/${personId}/profile`).then((r) => setP(r.data)); }, [personId]);

  return (
    <section aria-labelledby="profile" className="py-12">
      <button className="text-sm text-muted hover:text-ink" onClick={onBack}>Back to everyone</button>
      {!p ? <p className="mt-6 text-muted">Loading…</p> : (
        <>
          <h2 id="profile" className="mt-4 text-3xl font-semibold">{p.person.name}</h2>
          <p className="mt-1 text-sm text-muted">
            Last {p.days} days, all their devices. {p.totals.requests.toLocaleString()} requests, {compact(p.totals.outputTokens)} output
            tokens, {usd(p.totals.cost)} at API prices.
          </p>

          <Flags p={p} />
          <div className="mt-12">
            <h3 className="text-xl font-semibold">When</h3>
            <div className="mt-1"><HourHeatmap cells={p.hours} tz={p.timezone} /></div>
          </div>
          <Where p={p} />
          <How p={p} />

          <p className="mt-12 max-w-[66ch] border-t border-rule pt-6 text-sm text-muted">
            What this can't tell you: whether the work was useful, what was asked, or what code was written. None of that
            leaves their machine. Numbers cover Claude Code only, not claude.ai chat, and a device that was offline or had
            the plugin removed simply shows less.
          </p>
        </>
      )}
    </section>
  );
}

function Flags({ p }: { p: P }) {
  if (!p.flags.length) {
    return <p className="mt-8 rounded-lg bg-band px-5 py-4 text-sm">Nothing crosses your thresholds this week.</p>;
  }
  return (
    <ul className="mt-8 space-y-4">
      {p.flags.map((f) => (
        <li key={f.key} className={`rounded-lg border-l-4 bg-band px-5 py-4 ${f.severity === 'alert' ? 'border-limit' : 'border-ahead'}`}>
          <p className="font-medium">{f.title}</p>
          <p className="mt-1 text-sm">{f.evidence}</p>
          <p className="mt-1 text-sm text-muted">Keep in mind: {f.caveat}</p>
        </li>
      ))}
    </ul>
  );
}

function Bar({ label, value, total, note }: { label: string; value: number; total: number; note: string }) {
  const s = total > 0 ? value / total : 0;
  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted">{note}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-[2px] bg-track" aria-hidden>
        <div className="h-full rounded-[2px] bg-fill" style={{ width: `${s * 100}%` }} />
      </div>
    </li>
  );
}

function Where({ p }: { p: P }) {
  const total = p.repoShare.work + p.repoShare.outside + p.repoShare.none;
  return (
    <div className="mt-12">
      <h3 className="text-xl font-semibold">Where</h3>
      {!p.workNamespacesSet && (
        <p className="mt-1 text-sm text-ahead">List your work namespaces in Settings to split work from outside repositories.</p>
      )}
      <ul className="mt-4 space-y-4">
        {(['work', 'outside', 'none'] as const).filter((c) => p.workNamespacesSet || c !== 'work').map((c) => (
          <Bar key={c} label={c === 'outside' && !p.workNamespacesSet ? 'With a repository' : CLASS_LABEL[c]}
            value={p.repoShare[c]} total={total} note={`${total ? Math.round((p.repoShare[c] / total) * 100) : 0}% of cost`} />
        ))}
      </ul>
      {p.repos.length > 0 && (
        <table className="mt-6 w-full text-sm">
          <thead><tr className="text-left text-muted"><th className="py-1 font-normal">Repository</th><th className="font-normal">Requests</th><th className="text-right font-normal">Cost</th></tr></thead>
          <tbody className="divide-y divide-rule">
            {p.repos.map((r) => (
              <tr key={r.repo ?? '-'}>
                <td className="py-1.5">
                  {r.repo ?? <span className="text-muted">No repository</span>}
                  {r.class === 'outside' && p.workNamespacesSet && <span className="ml-2 text-xs text-ahead">outside work</span>}
                </td>
                <td>{r.requests.toLocaleString()}</td>
                <td className="text-right">{usd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Counts({ title, rows, empty }: { title: string; rows: [string, string][]; empty: string }) {
  return (
    <div>
      <h4 className="font-medium">{title}</h4>
      {rows.length === 0 ? <p className="mt-1 text-sm text-muted">{empty}</p> : (
        <dl className="mt-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-rule py-1"><dt>{k}</dt><dd className="text-muted">{v}</dd></div>
          ))}
        </dl>
      )}
    </div>
  );
}

function How({ p }: { p: P }) {
  const decisions = p.permissionModes.reduce((s, m) => s + m.n, 0);
  return (
    <div className="mt-12">
      <h3 className="text-xl font-semibold">How</h3>
      <div className="mt-4 grid gap-8 sm:grid-cols-2">
        <Counts title="Models" empty="No requests."
          rows={p.models.map((m) => [`${m.model}${m.effort ? `, ${m.effort} effort` : ''}`, `${m.requests} req, ${usd(m.cost)}`])} />
        <Counts title="Who made the requests" empty="No requests."
          rows={p.querySources.map((q) => [q.source === 'main' ? 'Main conversation' : q.source, `${q.requests} req, ${usd(q.cost)}`])} />
        <Counts title="Tools" empty="No tool calls reported."
          rows={p.tools.map((t) => [t.tool, `${t.calls} call${t.calls === 1 ? '' : 's'}${t.failures ? `, ${t.failures} failed` : ''}`])} />
        <Counts title="Permission mode when tools ran" empty="No tool decisions reported."
          rows={p.permissionModes.map((m) => [m.mode, `${Math.round((m.n / decisions) * 100)}%`])} />
        <Counts title="Prompts and context" empty=""
          rows={[
            ['Prompts sent', p.prompts.count.toLocaleString()],
            ['Average prompt length', `${p.prompts.avgLength.toLocaleString()} characters`],
            ...p.compactions.map((c): [string, string] => [`Compactions, ${c.trigger}`, String(c.n)]),
          ]} />
        <Counts title="Subagents and errors" empty="None."
          rows={[
            ...p.subagents.map((s): [string, string] => [`Subagent: ${s.agent}`, `${s.n} runs`]),
            ...p.apiErrors.map((e): [string, string] => [`API error ${e.status}`, String(e.n)]),
          ]} />
      </div>
    </div>
  );
}
