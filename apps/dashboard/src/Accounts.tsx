// Claude accounts: one per login or setup token, each with its own 5h and weekly allowance. Owned by a team or shared.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Go } from './Home.tsx';
import { ago, call, isUnlabeled, type AccountRow, type Overview } from './lib.ts';
import { Card, Modal, PageHead, Pill, RowMenu, Th } from './ui.tsx';

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function AccountsPage({ data, go, reload }: { data: Overview; go: Go; reload: () => void }) {
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [modal, setModal] = useState<{ account?: AccountRow } | null>(null);
  const [msg, setMsg] = useState('');
  const isSuper = data.viewer.role === 'superadmin';

  const load = useCallback(async () => {
    const r = await call<{ accounts: AccountRow[] }>('/api/dashboard/accounts');
    if (r.status === 200) { setRows(r.data.accounts); setFailed(false); } else setFailed(true);
  }, []);
  useEffect(() => { load(); }, [load, data]);

  const meter = (id: number, key: string) => data.meters.find((m) => m.accountId === id && m.meterKey === key && !m.expired);
  const unlabeled = (rows ?? []).filter((a) => isUnlabeled(a.label));
  const undetected = data.installations.filter((d) => !d.revoked && d.accountId === null);
  const personName = (id: number | null) => data.people.find((p) => p.id === id)?.name;
  const assign = async (deviceId: number, deviceName: string, accountId: number) => {
    const r = await call(`/api/dashboard/installations/${deviceId}`, 'PATCH', { accountId });
    setMsg(r.status === 200 ? `${deviceName} is now filed under ${rows?.find((a) => a.id === accountId)?.label}.` : `Could not set the account for ${deviceName}.`);
    load(); reload();
  };

  const attribute = async () => {
    const r = await call('/api/dashboard/accounts/attribute', 'POST');
    setMsg(r.status === 200 ? `Filed ${r.data.readings} readings and ${r.data.requests} requests under their device’s account.` : 'Could not file older readings.');
    load(); reload();
  };

  return (
    <div className="space-y-8">
      <PageHead
        title="Claude accounts"
        sub="Each Claude account has its own 5-hour and weekly allowance, shared by every login and setup token on it. Devices report which account they use; the monitor keeps only a one-way hash of the account id, never the email."
        action={<button type="button" className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper" onClick={() => setModal({})}>Add account</button>}
      />

      {unlabeled.length > 0 && (
        <Card title={`${unlabeled.length} account${unlabeled.length === 1 ? '' : 's'} need${unlabeled.length === 1 ? 's' : ''} a name`}
          sub="A device started using an account nobody set up. Name it after its owner or token and pick the team that owns it.">
          <div className="flex flex-wrap gap-2">
            {unlabeled.map((a) => a.canEdit && (
              <button key={a.id} type="button" className="rounded-md border border-rule bg-paper px-3 py-1.5 text-sm hover:border-ink" onClick={() => setModal({ account: a })}>
                Name {a.label}
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-rule">
              <tr><Th>Account</Th><Th>Owner</Th><Th>Devices on it</Th><Th right>This week</Th><Th right>5h</Th><Th>Last reading</Th><Th /></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {(rows ?? []).map((a) => {
                const week = meter(a.id, 'seven_day'), five = meter(a.id, 'five_hour');
                return (
                  <tr key={a.id} className="hover:bg-band/40">
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {a.label}
                        {isUnlabeled(a.label) && <Pill tone="warn">Name me</Pill>}
                        {rows!.some((b) => b.id !== a.id && sameName(a.label, b.label)) && <Pill tone="warn">Same name twice</Pill>}
                        {!a.detected && <Pill tone="info">{a.devices.length ? 'Set by hand, not confirmed yet' : 'Waiting for first device'}</Pill>}
                      </span>
                    </td>
                    <td className="px-3">{a.teamName ?? <span className="text-muted">Shared</span>}</td>
                    <td className="px-3">
                      {a.devices.length ? (
                        <ul className="space-y-0.5">
                          {a.devices.map((d) => (
                            <li key={d.id}>
                              {d.personId ? <button className="hover:underline" onClick={() => go(`/people/${d.personId}`)}>{d.personName}</button> : d.name}
                              <span className="text-xs text-muted">, {d.name}</span>
                            </li>
                          ))}
                        </ul>
                      ) : !a.otherTeamDevices && <span className="text-muted">None yet</span>}
                      {a.otherTeamDevices > 0 && <p className="text-xs text-muted">+{a.otherTeamDevices} on other teams</p>}
                    </td>
                    <td className="px-3 text-right tabular-nums">{week ? `${Math.round(week.usedPercentage)}%` : <span className="text-muted">n/a</span>}</td>
                    <td className="px-3 text-right tabular-nums">{five ? `${Math.round(five.usedPercentage)}%` : <span className="text-muted">n/a</span>}</td>
                    <td className="px-3 text-muted">{a.lastReadingAt ? ago(a.lastReadingAt) : 'Never'}</td>
                    <td className="px-3 text-right">
                      {a.canEdit && <RowMenu label={`Actions for ${a.label}`} items={[{ label: isSuper ? 'Rename or change owner' : 'Rename', onClick: () => setModal({ account: a }) }]} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows && !failed && <p role="status" className="py-6 text-center text-sm text-muted">Loading accounts…</p>}
          {failed && (
            <p role="alert" className="py-6 text-center text-sm text-limit">
              Couldn’t load accounts. <button type="button" className="font-medium underline" onClick={load}>Try again</button>
            </p>
          )}
          {rows && !rows.length && (
            <p className="py-6 text-center text-sm text-muted">
              No accounts yet. They appear on their own when a device makes its first Claude Code request, or add one now and pick it when you invite someone.
            </p>
          )}
        </div>
      </Card>

      {undetected.length > 0 && (
        <Card title={`Devices without an account (${undetected.length})`}
          sub="These devices haven’t reported which Claude account they use, so their usage shows as Unattributed. Pick the account you know they’re on. Their next Claude Code request confirms it: an account with no device yet takes on the one they report, and if they report an account that’s already listed, they move there.">
          <ul className="divide-y divide-rule">
            {undetected.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-sm">
                  <span className="font-medium">{personName(d.personId) ?? d.name}</span>
                  <span className="text-muted">, {d.name}, seen {d.lastHeartbeatAt ? ago(d.lastHeartbeatAt) : 'never'}</span>
                </span>
                <select aria-label={`Claude account for ${d.name}`} value="" disabled={!rows?.length}
                  onChange={(e) => e.target.value && assign(d.id, d.name, Number(e.target.value))}
                  className="rounded-md border border-rule bg-paper px-3 py-1.5 text-sm">
                  <option value="">{rows?.length ? 'Pick an account…' : 'Add an account first'}</option>
                  {(rows ?? []).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}

      {isSuper && (
        <Card title="Readings from before accounts were detected"
          sub="Readings and requests that arrived before this version have no account, so they show as Unattributed. This files each one under its device’s current account. Only do it once every device has reported: a device that switched accounts during the week would be misfiled.">
          <button type="button" className="whitespace-nowrap rounded-md border border-rule bg-card px-3.5 py-2 text-sm font-medium hover:bg-band" onClick={attribute}>File older readings under accounts</button>
        </Card>
      )}

      {modal && <AccountModal account={modal.account} rows={rows ?? []} data={data} onClose={() => setModal(null)}
        onSaved={(note) => { setModal(null); setMsg(note ?? ''); load(); reload(); }} />}
    </div>
  );
}

function AccountModal({ account, rows, data, onClose, onSaved }: {
  account?: AccountRow; rows: AccountRow[]; data: Overview; onClose: () => void; onSaved: (note?: string) => void;
}) {
  const isSuper = data.viewer.role === 'superadmin';
  const [label, setLabel] = useState(account && !isUnlabeled(account.label) ? account.label : '');
  const [teamId, setTeamId] = useState(String(account ? account.teamId ?? '' : data.teams[0]?.id ?? ''));
  const [error, setError] = useState('');
  const canPickTeam = isSuper || !account; // leads create accounts for their teams but can't move them
  // A name that's already taken means the same Claude account: offer to merge instead of making a second row.
  const twin = label.trim() ? rows.find((b) => b.id !== account?.id && sameName(b.label, label)) : undefined;
  const blocked = twin && (!account ? `An account named ${twin.label} already exists. Pick it when you invite someone, or use another name.`
    : !twin.canEdit ? `${twin.label} belongs to another team. Ask a superadmin to merge them.` : '');
  // The weekly allowance is the best evidence: one Claude account has one weekly reset time and one percentage.
  const week = (id: number) => data.meters.find((m) => m.accountId === id && m.meterKey === 'seven_day' && !m.expired);
  const [mine, theirs] = account && twin ? [week(account.id), week(twin.id)] : [];
  const evidence = !mine || !theirs ? ''
    : mine.resetsAt === theirs.resetsAt && Math.round(mine.usedPercentage) === Math.round(theirs.usedPercentage)
      ? `Both show the same weekly allowance (${Math.round(mine.usedPercentage)}%, same reset time), so they are one Claude account.`
      : `Their weekly allowances differ (${Math.round(mine.usedPercentage)}% and ${Math.round(theirs.usedPercentage)}%), which usually means two separate Claude accounts. Merge only if you are sure.`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return setError('Give the account a name, e.g. whose login or token it is.');
    if (blocked) return setError(blocked);
    if (twin && account) {
      const r = await call<{ readings: number; requests: number; error?: string }>(`/api/dashboard/accounts/${account.id}/merge`, 'POST', { into: twin.id });
      if (r.status >= 400) return setError(r.data?.error ?? 'Could not merge the accounts.');
      return onSaved(`Merged into ${twin.label}: its devices, ${r.data.readings} readings and ${r.data.requests} requests moved there.`);
    }
    const body = { label: label.trim(), ...(canPickTeam ? { teamId: teamId ? Number(teamId) : null } : {}) };
    const r = account ? await call(`/api/dashboard/accounts/${account.id}`, 'PATCH', body) : await call('/api/dashboard/accounts', 'POST', body);
    if (r.status >= 400) return setError(r.data?.error ?? 'Could not save the account.');
    onSaved();
  };
  return (
    <Modal open onClose={onClose} title={account ? `Edit ${account.label}` : 'Add a Claude account'}
      sub={account ? undefined : 'Add it before inviting the people who use its setup token. The first device that joins with it links the account automatically.'}>
      <form onSubmit={submit} className="space-y-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">Name
          <input autoFocus value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Backend seat (Shamim’s token)"
            className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal" />
        </label>
        {canPickTeam && !(twin && account) && data.teams.length > 0 && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">Owner team
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal">
              {isSuper && <option value="">Shared (no owner team)</option>}
              {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <span className="text-xs font-normal text-muted">Anyone may use any account; the owner team’s leads manage it and see its alerts.</span>
          </label>
        )}
        {twin && account && !blocked && (
          <p className="rounded-md border border-rule bg-band px-3 py-2 text-sm">
            {`${twin.label} already exists. Saving merges them: this account’s devices, readings and requests move to ${twin.label}, `}
            {`which keeps its owner team, and later requests from these devices land there too. ${evidence}`}
          </p>
        )}
        {blocked && <p className="text-sm text-limit">{blocked}</p>}
        {error && error !== blocked && <p className="text-sm text-limit">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band">Cancel</button>
          <button disabled={!!blocked} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50">
            {twin && account && !blocked ? `Merge into ${twin.label}` : account ? 'Save' : 'Add account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
