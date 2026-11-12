// Admin building blocks: cards, KPI tiles, status pills, sparklines, filter chips, row menus.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Card({ title, sub, action, children, className = '' }: {
  title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`min-w-0 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-ink pb-2">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
const TONES: Record<Tone, string> = {
  good: 'bg-[color-mix(in_oklab,var(--fill)_16%,transparent)] text-fill',
  warn: 'bg-[color-mix(in_oklab,var(--ahead)_18%,transparent)] text-ahead',
  bad: 'bg-[color-mix(in_oklab,var(--limit)_15%,transparent)] text-limit',
  info: 'bg-[color-mix(in_oklab,var(--s1)_15%,transparent)] text-[var(--s1)]',
  neutral: 'bg-band text-muted',
};
/** Status pill: always text, never colour alone. */
export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function Kpi({ label, value, pill, foot, spark, icon: _icon }: {
  label: string; value: ReactNode; pill?: ReactNode; foot?: ReactNode; spark?: number[]; icon?: ReactNode;
}) {
  return (
    <section className="min-w-0 border-t-2 border-ink pt-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">{label}</p>
        {spark && spark.length > 1 && <Sparkline values={spark} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="reading text-[2.6rem]">{value}</p>
        {pill}
      </div>
      {foot && <p className="mt-2 text-xs text-muted">{foot}</p>}
    </section>
  );
}

export function Sparkline({ values, width = 72, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${height - 2 - (v / max) * (height - 4)}`).join(' ');
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--fill)" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={(values.length - 1) * step} cy={height - 2 - (values[values.length - 1] / max) * (height - 4)} r="2.5" fill="var(--fill)" />
    </svg>
  );
}

export function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string, number?][] }) {
  return (
    <div role="radiogroup" aria-label="Filter" className="flex flex-wrap gap-1.5">
      {options.map(([v, label, n]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={`rounded-full border px-3 py-1 text-sm ${value === v ? 'border-ink bg-ink text-paper' : 'border-rule bg-card text-muted hover:text-ink'}`}>
          {label}{n !== undefined && <span className="ml-1.5 opacity-70">{n}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-1.5 text-sm">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="w-56 bg-transparent outline-none" />
    </label>
  );
}

/** Initials in the person's chart colour, so the table, charts and legend all match. */
export function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  // Tinted fill + ring in the person's colour; the initials stay in ink so they're readable on every hue.
  return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-ink" style={{ background: `color-mix(in oklab, ${color} 30%, var(--card))`, boxShadow: `inset 0 0 0 2px ${color}` }} aria-hidden>{initials}</span>;
}

/** Row action menu (⋯). Closes on outside click or Escape. */
export function RowMenu({ label, items }: { label: string; items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <button aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md px-2 py-1 text-muted hover:bg-band hover:text-ink">⋯</button>
      {open && (
        <ul role="menu" className="absolute right-0 z-30 mt-1 min-w-44 rounded-lg border border-rule bg-card py-1 text-sm shadow-[0_4px_16px_rgb(0_0_0/0.12)]">
          {items.map((i) => (
            <li key={i.label} role="none">
              <button role="menuitem" onClick={() => { setOpen(false); i.onClick(); }}
                className={`block w-full px-3 py-1.5 text-left hover:bg-band ${i.danger ? 'text-limit' : ''}`}>{i.label}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PageHead({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{sub}</p>
      </div>
      {action}
    </div>
  );
}

/** Share bar inside a table cell. */
export function ShareCell({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-[2px] bg-track" aria-hidden><div className="h-full rounded-[2px]" style={{ width: `${Math.min(100, value)}%`, background: color }} /></div>
      <span className="tabular-nums">{value}%</span>
    </div>
  );
}

export const Th = ({ children, right }: { children?: ReactNode; right?: boolean }) => (
  <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-xs font-medium text-muted ${right ? 'text-right' : 'text-left'}`}>{children}</th>
);
