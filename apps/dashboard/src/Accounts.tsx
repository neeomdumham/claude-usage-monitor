// Claude accounts: one per login or setup token, each with its own 5h and weekly allowance. Owned by a team or shared.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Go } from './Home.tsx';
import { ago, call, isUnlabeled, type AccountRow, type Overview } from './lib.ts';
import { Card, Modal, PageHead, Pill, RowMenu, Th } from './ui.tsx';

export function AccountsPage({ data, go, reload }: { data: Overview; go: Go; reload: () => void }) {
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [undetected, setUndetected] = useState(0);
  const [modal, setModal] = useState<{ account?: AccountRow } | null>(null);
  const [msg, setMsg] = useState('');
  const isSuper = data.viewer.role === 'superadmin';

  const load = useCallback(async () => {
    const r = await call<{ accounts: AccountRow[]; unattributedDevices: number }>('/api/dashboard/accounts');
    if (r.status === 200) { setRows(r.data.accounts); setUndetected(r.data.unattributedDevices); }
  }, []);
  useEffect(() => { load(); }, [load, data]);

  const meter = (id: number, key: string) => data.meters.find((m) => m.accountId === id && m.meterKey === key && !m.expired);
  const unlabeled = (rows ?? []).filter((a) => isUnlabeled(a.label));

  const attribute = async () => {
    const r = await call('/api/dashboard/accounts/attribute', 'POST');
    setMsg(r.status === 200 ? `Filed ${r.data.readings} readings and ${r.data.requests} requests under their device’s account.` : 'Could not file older readings.');
    load(); reload();
  };

  return (
    <div className="space-y-8">
      <PageHead
        title="Claude accounts"
        sub="Each Claude login or setup token has its own 5-hour and weekly allowance. Devices report which account they use; the monitor keeps only a one-way hash of the account id, never the email."
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
                        {!a.detected && <Pill tone="info">Waiting for first device</Pill>}
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
          {rows && !rows.length && (
            <p className="py-6 text-center text-sm text-muted">
              No accounts yet. They appear on their own when a device makes its first Claude Code request, or add one now and pick it when you invite someone.
            </p>
          )}
        </div>
        {undetected > 0 && (
          <p className="mt-4 text-sm text-muted">
            {undetected} device{undetected === 1 ? ' hasn’t' : 's haven’t'} reported an account yet. Their readings show as Unattributed until their next Claude Code request.
          </p>
        )}
      </Card>

      {isSuper && (
        <Card title="Readings from before accounts were detected"
          sub="Readings and requests that arrived before this version have no account, so they show as Unattributed. This files each one under its device’s current account. Only do it once every device has reported: a device that switched accounts during the week would be misfiled.">
          <button type="button" className="rounded-md border border-rule bg-card px-3.5 py-2 text-sm font-medium hover:bg-band" onClick={attribute}>File older readings under accounts</button>
          {msg && <p role="status" className="mt-3 text-sm text-muted">{msg}</p>}
        </Card>
      )}

      {modal && <AccountModal account={modal.account} data={data} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); reload(); }} />}
    </div>
  );
}

function AccountModal({ account, data, onClose, onSaved }: { account?: AccountRow; data: Overview; onClose: () => void; onSaved: () => void }) {
  const isSuper = data.viewer.role === 'superadmin';
  const [label, setLabel] = useState(account && !isUnlabeled(account.label) ? account.label : '');
  const [teamId, setTeamId] = useState(String(account ? account.teamId ?? '' : data.teams[0]?.id ?? ''));
  const [error, setError] = useState('');
  const canPickTeam = isSuper || !account; // leads create accounts for their teams but can't move them
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return setError('Give the account a name, e.g. whose login or token it is.');
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
        {canPickTeam && data.teams.length > 0 && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">Owner team
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal">
              {isSuper && <option value="">Shared (no owner team)</option>}
              {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <span className="text-xs font-normal text-muted">Anyone may use any account; the owner team’s leads manage it and see its alerts.</span>
          </label>
        )}
        {error && <p className="text-sm text-limit">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band">Cancel</button>
          <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">{account ? 'Save' : 'Add account'}</button>
        </div>
      </form>
    </Modal>
  );
}
