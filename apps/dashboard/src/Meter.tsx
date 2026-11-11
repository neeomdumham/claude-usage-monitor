import { ago, clock, meterName, pace, until, windowSeconds, type Meter as M } from './lib.ts';

const SOURCE: Record<string, string> = {
  statusline: 'from a Claude Code status line',
  'stream-json': 'from a headless Claude Code run',
  manual: 'entered by you',
};

/** Time segments from the upstream window boundary: each day (weekly) or hour (session), labelled at its middle. */
function ticks(m: M, tz: string) {
  const len = windowSeconds(m.meterKey)!;
  const step = len > 86400 ? 86400 : 3600;
  const start = m.resetsAt - len;
  const out = [];
  for (let t = start; t < m.resetsAt; t += step) {
    out.push({
      at: (t - start + step / 2) / len,
      edge: (t - start) / len,
      label: step === 86400
        ? new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short' }).format(t * 1000)
        : clock(t, tz, false),
    });
  }
  return out;
}

export function Meter({ m, tz, hero = false }: { m: M; tz: string; hero?: boolean }) {
  const p = pace(m);
  const weekly = (windowSeconds(m.meterKey) ?? 0) > 86400;
  const tone = m.usedPercentage >= 90 ? 'limit' : p?.hitsLimitAt ? 'ahead' : 'fill';
  const fillClass = { fill: 'bg-fill', ahead: 'bg-ahead', limit: 'bg-limit' }[tone];
  const name = meterName(m);

  return (
    <article aria-label={name} className={hero ? '' : 'py-6'}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className={hero ? 'text-lg font-medium' : 'text-base font-medium'}>{name}</h2>
        {!m.expired && (
          <p className="text-sm text-muted">
            Resets {clock(m.resetsAt, tz, weekly)}, in {until(m.resetsAt)}
          </p>
        )}
      </header>

      {m.expired ? (
        <p className="mt-3 text-sm text-muted">
          This window reset at {clock(m.resetsAt, tz, weekly)}. The next Claude Code response will bring a fresh reading.
        </p>
      ) : (
        <>
          <div className="mt-2 flex items-end gap-5">
            <p className={`reading ${hero ? 'text-[7.5rem] sm:text-[9rem]' : 'text-6xl'}`}>
              {Math.round(m.usedPercentage)}
              <span className={hero ? 'text-[0.45em]' : 'text-[0.5em]'}>%</span>
            </p>
            <p className="pb-2 text-sm text-muted">{hero ? "used of this window's allowance" : 'used'}</p>
          </div>

          <div className={`relative ${hero ? 'mt-6 mb-7' : 'mt-4 mb-6'}`}>
            <div
              role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.usedPercentage}
              aria-label={`${name}: ${m.usedPercentage}% used`}
              className={`relative overflow-hidden rounded-[3px] bg-track ${hero ? 'h-5' : 'h-2.5'}`}
            >
              <div className={`fill-in absolute inset-y-0 left-0 ${fillClass}`} style={{ width: `${Math.min(100, m.usedPercentage)}%` }} />
              {hero && p && ticks(m, tz).slice(1).map((t) => (
                <span key={t.edge} className="absolute inset-y-0 w-px bg-paper/60" style={{ left: `${t.edge * 100}%` }} aria-hidden />
              ))}
            </div>
            {p && (
              <>
                <div className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-ink" style={{ left: `calc(${p.elapsed * 100}% - 1px)` }} aria-hidden />
                <span className="absolute -top-6 -translate-x-1/2 text-xs font-medium" style={{ left: `${p.elapsed * 100}%` }} aria-hidden>now</span>
              </>
            )}
            {hero && p && (
              <div className="absolute inset-x-0 top-full mt-2 h-4 text-xs text-muted" aria-hidden>
                {ticks(m, tz).map((t) => (
                  <span key={t.at} className="absolute -translate-x-1/2" style={{ left: `${t.at * 100}%` }}>{t.label}</span>
                ))}
              </div>
            )}
          </div>

          <PaceLine m={m} tz={tz} weekly={weekly} hero={hero} />
        </>
      )}

      <p className="mt-1 text-xs text-muted">
        Read {ago(m.observedAt)}, {SOURCE[m.source] ?? m.source}.
        {m.stale && <span className="ml-1 font-medium text-ahead">Possibly out of date: no device has reported since.</span>}
      </p>
    </article>
  );
}

function PaceLine({ m, tz, weekly, hero }: { m: M; tz: string; weekly: boolean; hero: boolean }) {
  const p = pace(m);
  if (!p) return null;
  const cls = hero ? 'mt-3 text-base' : 'text-sm';
  if (p.hitsLimitAt) {
    return (
      <p className={`${cls} font-medium text-ahead`}>
        Ahead of the clock. At this rate the allowance runs out around {clock(p.hitsLimitAt, tz, weekly)}, before it resets.
      </p>
    );
  }
  if (p.projected === null) {
    return <p className={`${cls} text-muted`}>Too early in the window to project.</p>;
  }
  return (
    <p className={cls}>
      {Math.round(p.elapsed * 100)}% of the window has passed. At this rate, about {Math.round(p.projected)}% will be used by reset.
    </p>
  );
}
