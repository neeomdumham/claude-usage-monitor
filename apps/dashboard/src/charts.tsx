// Hand-rolled SVG charts (no chart dependency) + clickable GitHub-style 52-week/year Contribution Calendar.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { compact, usd, type CalendarDay, type CalendarResponse } from './lib.ts';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
};

export const dayLabel = (d: string, withWeekday = true) => {
  const dt = new Date(`${d}T12:00:00Z`);
  return new Intl.DateTimeFormat('en', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withWeekday ? { weekday: 'short' } : {}) }).format(dt);
};

export function Legend({ items }: { items: { label: string; color: string; line?: boolean; dash?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.line
            ? <svg width="16" height="8" aria-hidden><line x1="0" x2="16" y1="4" y2="4" stroke={i.color} strokeWidth="2" strokeDasharray={i.dash ? '3 3' : undefined} /></svg>
            : <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: i.color }} aria-hidden />}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), width - 228);
  return (
    <div role="status" className="pointer-events-none absolute top-0 z-10 w-[220px] rounded-md bg-paper p-3 text-sm shadow-[var(--shadow-float)] ring-1 ring-rule" style={{ left }}>
      {children}
    </div>
  );
}

function TipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted">
        <svg width="10" height="4" aria-hidden><line x1="0" x2="10" y1="2" y2="2" stroke={color} strokeWidth="3" /></svg>{label}
      </span>
      <strong className="font-semibold">{value}</strong>
    </div>
  );
}

export type Series = { id: string; label: string; color: string; values: number[] };

/** Stacked daily bars. Hover or focus a day for every series' value. */
export function StackedBars({ days, series, format, height = 220, label }: {
  days: string[]; series: Series[]; format: (n: number) => string; height?: number; label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const M = { l: 48, r: 8, t: 8, b: 24 };
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = niceMax(Math.max(...totals, 0));
  const iw = width - M.l - M.r, ih = height - M.t - M.b;
  const band = iw / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(36, band * 0.68));
  const y = (v: number) => M.t + ih - (v / max) * ih;
  const every = Math.ceil(days.length / Math.max(1, Math.floor(iw / 72)));

  return (
    <figure ref={ref} className="relative min-w-0" aria-label={label}>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <svg width={width} height={height} className="mt-3 block max-w-full" role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={M.l} x2={width - M.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--rule)" strokeWidth="1" />
            <text x={M.l - 6} y={y(max * f) + 4} textAnchor="end" className="fill-muted text-[11px]">{format(max * f)}</text>
          </g>
        ))}
        {days.map((d, i) => {
          let acc = 0;
          const x = M.l + i * band + (band - bw) / 2;
          return (
            <g key={d} opacity={hover === null || hover === i ? 1 : 0.55}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                if (!v) return null;
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                return <rect key={s.id} x={x} y={y1} width={bw} height={Math.max(1, y0 - y1)} rx={2} fill={s.color} stroke="var(--paper)" strokeWidth={1} />;
              })}
              {i % every === 0 && (
                <text x={x + bw / 2} y={height - 6} textAnchor="middle" className="fill-muted text-[11px]">{dayLabel(d, days.length <= 10)}</text>
              )}
              <rect
                x={M.l + i * band} y={M.t} width={band} height={ih} fill="transparent" tabIndex={0} role="img"
                aria-label={`${dayLabel(d)}: ${format(totals[i])}`}
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tip x={M.l + hover * band + band / 2} width={width}>
          <p className="mb-1 font-medium">{dayLabel(days[hover])}: {format(totals[hover])}</p>
          {series.filter((s) => s.values[hover]).sort((a, b) => b.values[hover] - a.values[hover]).map((s) => (
            <TipRow key={s.id} color={s.color} label={s.label} value={format(s.values[hover])} />
          ))}
        </Tip>
      )}
    </figure>
  );
}

export type Line = { id: string; label: string; color: string; points: [number, number][]; width?: number };

export function BurnChart({ lines, start, end, tz, pace, height = 240 }: {
  lines: Line[]; start: number; end: number; tz: string; pace: boolean; height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hx, setHx] = useState<number | null>(null);
  const M = { l: 40, r: 12, t: 12, b: 24 };
  const iw = width - M.l - M.r, ih = height - M.t - M.b;
  const x = (t: number) => M.l + ((t - start) / (end - start)) * iw;
  const y = (v: number) => M.t + ih - (Math.min(100, v) / 100) * ih;
  const now = Math.min(end, Date.now() / 1000);
  const days = (end - start) / 86400;
  const step = days > 10 ? 7 * 86400 : days <= 1 ? 3600 : 86400;
  const ticks: number[] = [];
  for (let t = start; t <= end; t += step) ticks.push(t);
  const fmt = days <= 1
    ? new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
    : new Intl.DateTimeFormat('en', { timeZone: tz, weekday: days <= 10 ? 'short' : undefined, day: 'numeric', month: days > 10 ? 'short' : undefined });
  const valueAt = (l: Line, t: number) => {
    let v: number | null = null;
    for (const [pt, pv] of l.points) if (pt <= t) v = pv;
    return v;
  };
  const weekly = lines[0];
  const last = weekly?.points[weekly.points.length - 1];
  const projection = pace && last && last[1] > 0 && now > start + (end - start) * 0.08
    ? (() => {
      const rate = last[1] / (now - start);
      const hit = start + 100 / rate;
      return hit < end ? { from: [now, last[1]], to: [hit, 100] as [number, number], hits: hit } : { from: [now, last[1]], to: [end, rate * (end - start)] as [number, number], hits: null };
    })()
    : null;

  return (
    <figure ref={ref} className="relative min-w-0" aria-label="Allowance used over time">
      <Legend items={[
        ...lines.map((l) => ({ label: l.label, color: l.color, line: true })),
        ...(pace ? [{ label: 'Even pace to reset', color: 'var(--muted)', line: true, dash: true }] : []),
        ...(projection ? [{ label: 'At the current rate', color: 'var(--ahead)', line: true, dash: true }] : []),
      ]} />
      <svg
        width={width} height={height} className="mt-3 block max-w-full touch-none" role="img"
        aria-label={`Allowance used over time. ${lines.map((l) => `${l.label}: ${l.points.at(-1)?.[1] ?? 'no'}%`).join('. ')}`}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGElement).getBoundingClientRect();
          const t = start + ((e.clientX - r.left - M.l) / iw) * (end - start);
          setHx(t >= start && t <= now ? t : null);
        }}
        onPointerLeave={() => setHx(null)}
      >
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} stroke={v === 100 ? 'var(--limit)' : 'var(--rule)'} strokeWidth="1" strokeDasharray={v === 100 ? '4 3' : undefined} />
            <text x={M.l - 6} y={y(v) + 4} textAnchor="end" className="fill-muted text-[11px]">{v}%</text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t + step / 2)} y={height - 6} textAnchor="middle" className="fill-muted text-[11px]">{x(t + step / 2) < width - M.r ? fmt.format(t * 1000) : ''}</text>
        ))}
        {pace && <line x1={x(start)} y1={y(0)} x2={x(end)} y2={y(100)} stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="3 3" />}
        {projection && last && (
          <>
            <line x1={x(projection.from[0])} y1={y(projection.from[1])} x2={x(projection.to[0])} y2={y(projection.to[1])} stroke="var(--ahead)" strokeWidth="2" strokeDasharray="3 3" />
            {projection.hits && <circle cx={x(projection.hits)} cy={y(100)} r="4" fill="var(--ahead)" stroke="var(--paper)" strokeWidth="2" />}
          </>
        )}
        {lines.map((l) => (
          <polyline key={l.id} fill="none" stroke={l.color} strokeWidth={l.width ?? 2} strokeLinejoin="round"
            points={l.points.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')} />
        ))}
        <line x1={x(now)} x2={x(now)} y1={M.t} y2={M.t + ih} stroke="var(--ink)" strokeWidth="1" />
        <text x={x(now)} y={M.t + 10} dx="4" className="fill-ink text-[11px]">now</text>
        {hx !== null && <line x1={x(hx)} x2={x(hx)} y1={M.t} y2={M.t + ih} stroke="var(--muted)" strokeWidth="1" />}
      </svg>
      {hx !== null && (
        <Tip x={x(hx)} width={width}>
          <p className="mb-1 font-medium">{new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(hx * 1000)}</p>
          {lines.map((l) => {
            const v = valueAt(l, hx);
            return <TipRow key={l.id} color={l.color} label={l.label} value={v === null ? 'no reading' : `${Math.round(v)}%`} />;
          })}
        </Tip>
      )}
      {projection?.hits && (
        <p className="mt-2 text-sm font-medium text-ahead">
          At this rate the allowance runs out {new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(projection.hits * 1000)}, before it resets.
        </p>
      )}
    </figure>
  );
}

export type CalendarMetric = 'requests' | 'costUsd' | 'sessions' | 'commits';
export type CalendarSelection =
  | { kind: 'day'; day: string }
  | { kind: 'week'; start: string; end: string }
  | null;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function addDaysUtc(iso: string, delta: number): string {
  const dt = new Date(`${iso}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/**
 * Clickable GitHub-style 52-week / full-year contribution calendar.
 * Click any day square to inspect that day, click any week column header to inspect the entire week,
 * or pick a year from the right rail.
 */
export function ContributionCalendar({
  data, metric, selected, onSelectDay, onSelectWeek, onSelectYear,
}: {
  data: CalendarResponse;
  metric: CalendarMetric;
  selected: CalendarSelection;
  onSelectDay: (day: string) => void;
  onSelectWeek: (start: string, end: string) => void;
  onSelectYear: (year: number | null) => void;
}) {
  const [hovered, setHovered] = useState<CalendarDay | null>(null);

  const byDay = useMemo(() => new Map(data.days.map((d) => [d.day, d])), [data.days]);
  const metricVal = (d?: CalendarDay) => (!d ? 0 : d[metric]);
  const formatVal = (v: number) => (metric === 'costUsd' ? usd(v) : compact(v));

  const { weeks, maxVal, monthHeaders } = useMemo(() => {
    const startDt = new Date(`${data.startDay}T12:00:00Z`);
    const dow = (startDt.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
    const gridStart = addDaysUtc(data.startDay, -dow);
    const wks: { start: string; end: string; cells: (string | null)[] }[] = [];
    let cur = gridStart;
    while (cur <= data.endDay) {
      const cells: (string | null)[] = [];
      let wFirst: string | null = null;
      let wLast: string | null = null;
      for (let i = 0; i < 7; i++) {
        const d = addDaysUtc(cur, i);
        if (d >= data.startDay && d <= data.endDay) {
          cells.push(d);
          if (!wFirst) wFirst = d;
          wLast = d;
        } else {
          cells.push(null);
        }
      }
      if (wFirst && wLast) wks.push({ start: wFirst, end: wLast, cells });
      cur = addDaysUtc(cur, 7);
    }

    let max = 0;
    for (const d of data.days) max = Math.max(max, metricVal(d));

    const headers: { col: number; label: string }[] = [];
    let lastMonth = -1;
    wks.forEach((w, col) => {
      const firstValid = w.cells.find(Boolean);
      if (!firstValid) return;
      const m = Number(firstValid.slice(5, 7)) - 1;
      if (m !== lastMonth) {
        headers.push({ col, label: MONTH_SHORT[m] });
        lastMonth = m;
      }
    });
    return { weeks: wks, maxVal: max, monthHeaders: headers };
  }, [data.startDay, data.endDay, data.days, metric]);

  const levelColor = (v: number) => {
    if (v <= 0 || maxVal <= 0) return 'var(--track)';
    const ratio = v / maxVal;
    const pctFill = ratio > 0.75 ? 100 : ratio > 0.45 ? 74 : ratio > 0.2 ? 50 : 28;
    return `color-mix(in oklab, var(--fill) ${pctFill}%, var(--track))`;
  };

  const isSelectedDay = (d: string) =>
    selected?.kind === 'day' ? selected.day === d : selected?.kind === 'week' ? d >= selected.start && d <= selected.end : false;
  const isSelectedWeek = (w: { start: string; end: string }) =>
    selected?.kind === 'week' && selected.start === w.start && selected.end === w.end;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_132px]">
      <div className="min-w-0">
        <div className="overflow-x-auto pb-2">
          <div className="inline-block min-w-full">
            {/* Month labels row */}
            <div className="mb-1 flex items-center pl-8 text-[11px] text-muted" style={{ gap: 3 }}>
              {weeks.map((w, col) => {
                const mh = monthHeaders.find((h) => h.col === col);
                const activeWk = isSelectedWeek(w);
                return (
                  <button
                    key={w.start}
                    type="button"
                    title={`Inspect week of ${dayLabel(w.start, false)} to ${dayLabel(w.end, false)}`}
                    aria-label={mh ? `${mh.label}, week of ${w.start} to ${w.end}` : `Week of ${w.start} to ${w.end}`}
                    aria-pressed={activeWk}
                    onClick={() => onSelectWeek(w.start, w.end)}
                    className={`h-4 w-[14px] shrink-0 overflow-visible whitespace-nowrap text-left text-[10px] leading-4 hover:text-ink ${activeWk ? 'font-semibold text-ink underline' : 'text-muted'}`}
                  >
                    {mh ? mh.label : ''}
                  </button>
                );
              })}
            </div>

            {/* 7 rows x ~53 week columns */}
            <div className="flex gap-2">
              <div className="flex w-6 shrink-0 flex-col justify-between py-[1px] text-[10px] text-muted" aria-hidden>
                <span>Mon</span>
                <span>Wed</span>
                <span>Fri</span>
                <span>Sun</span>
              </div>
              <div className="flex" style={{ gap: 3 }}>
                {weeks.map((w) => (
                  <div key={w.start} className="flex flex-col" style={{ gap: 3 }}>
                    {w.cells.map((day, idx) => {
                      if (!day) return <span key={idx} className="h-[14px] w-[14px]" aria-hidden />;
                      const entry = byDay.get(day);
                      const v = metricVal(entry);
                      const active = isSelectedDay(day);
                      const hasOutside = (entry?.outsideRequests ?? 0) > 0;
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-label={`${dayLabel(day)}: ${formatVal(v)} (${entry?.sessions ?? 0} sessions, ${entry?.commits ?? 0} commits)`}
                          aria-pressed={active}
                          onClick={() => onSelectDay(day)}
                          onMouseEnter={() => setHovered(entry ?? { day, requests: 0, sessions: 0, costUsd: 0, commits: 0, xhighRequests: 0, outsideRequests: 0, activePeople: 0 })}
                          onMouseLeave={() => setHovered(null)}
                          onFocus={() => setHovered(entry ?? { day, requests: 0, sessions: 0, costUsd: 0, commits: 0, xhighRequests: 0, outsideRequests: 0, activePeople: 0 })}
                          className={`relative h-[14px] w-[14px] rounded-[2.5px] transition-transform hover:scale-110 ${active ? 'ring-2 ring-ink ring-offset-1 ring-offset-paper' : ''}`}
                          style={{ background: levelColor(v) }}
                        >
                          {hasOutside && <span className="absolute right-[1px] top-[1px] h-[4px] w-[4px] rounded-full bg-ahead" aria-hidden />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer: live readout + intensity legend */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <p className="min-h-[1.25rem]">
            {hovered ? (
              <span>
                <strong className="text-ink">{dayLabel(hovered.day)}</strong>: {hovered.requests.toLocaleString()} req, {hovered.sessions} sessions, {usd(hovered.costUsd)}, {hovered.commits} commits
                {hovered.xhighRequests > 0 && <span className="ml-1.5 font-medium text-limit">({hovered.xhighRequests} xhigh)</span>}
                {hovered.outsideRequests > 0 && <span className="ml-1.5 font-medium text-ahead">({hovered.outsideRequests} outside work)</span>}
              </span>
            ) : (
              <span>Click any day square or month/week column header to drill into sessions, people and commits.</span>
            )}
          </p>
          <div className="flex items-center gap-1.5" aria-hidden>
            <span>Less</span>
            {[0, 0.25, 0.5, 0.75, 1].map((r) => (
              <span key={r} className="inline-block h-3 w-3 rounded-[2px]"
                style={{ background: r === 0 ? 'var(--track)' : `color-mix(in oklab, var(--fill) ${Math.round(20 + 80 * r)}%, var(--track))` }} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>

      {/* GitHub-style Year selector rail */}
      <nav aria-label="Activity year" className="flex flex-wrap gap-1.5 lg:flex-col">
        <button
          type="button"
          onClick={() => onSelectYear(null)}
          aria-pressed={data.year === null}
          className={`rounded-md px-3 py-1.5 text-left text-xs font-medium ${data.year === null ? 'bg-ink text-paper' : 'text-muted hover:bg-band hover:text-ink'}`}
        >
          Last 12 months
        </button>
        {data.years.map((y) => (
          <button
            key={y}
            type="button"
            onClick={() => onSelectYear(y)}
            aria-pressed={data.year === y}
            className={`rounded-md px-3 py-1.5 text-left text-xs font-medium tabular-nums ${data.year === y ? 'bg-ink text-paper' : 'text-muted hover:bg-band hover:text-ink'}`}
          >
            {y}
          </button>
        ))}
      </nav>
    </div>
  );
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Requests by local hour and weekday, single-hue sequential. */
export function HourHeatmap({ cells, tz }: { cells: { dow: number; hour: number; requests: number }[]; tz: string }) {
  const max = Math.max(1, ...cells.map((h) => h.requests));
  const at = (dow: number, hour: number) => cells.find((h) => h.dow === dow && h.hour === hour)?.requests ?? 0;
  return (
    <div>
      <p className="text-sm text-muted">Requests by hour, {tz.replace('_', ' ')} time. Stronger colour is busier.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="border-separate border-spacing-[3px] text-xs">
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => <th key={h} scope="col" className="w-5 font-normal text-muted">{h % 6 === 0 ? h : ''}</th>)}
            </tr>
          </thead>
          <tbody>
            {DOW.map((d, i) => (
              <tr key={d}>
                <th scope="row" className="pr-2 text-left font-normal text-muted">{d}</th>
                {Array.from({ length: 24 }, (_, h) => {
                  const n = at(i + 1, h);
                  return (
                    <td key={h} title={`${d} ${h}:00, ${n} requests`} aria-label={`${d} ${h}:00, ${n} requests`} className="h-5 w-5 rounded-[2px]"
                      style={{ background: n ? `color-mix(in oklab, var(--fill) ${Math.min(100, Math.round(20 + (80 * n) / max))}%, var(--track))` : 'var(--track)' }} />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'ahead' | 'limit' }) {
  return (
    <div className="min-w-[8.5rem]">
      <p className="text-sm text-muted">{label}</p>
      <p className={`reading mt-1 text-4xl ${tone === 'ahead' ? 'text-ahead' : tone === 'limit' ? 'text-limit' : ''}`}>{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

export function ShareBars({ rows }: { rows: { id: string | number; label: string; color: string; value: number; note: string; onClick?: () => void }[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <ul className="space-y-4">
      {rows.map((r) => (
        <li key={r.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: r.color }} aria-hidden />
              {r.onClick ? <button className="underline decoration-rule underline-offset-4 hover:decoration-ink" onClick={r.onClick}>{r.label}</button> : r.label}
            </span>
            <span className="text-muted">{r.note}</span>
          </div>
          <div className="mt-1.5 h-1.5 rounded-[2px] bg-track" aria-hidden>
            <div className="h-full rounded-[2px]" style={{ width: `${total ? (r.value / total) * 100 : 0}%`, background: r.color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
