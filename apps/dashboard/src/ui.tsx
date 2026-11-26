// Admin building blocks: cards, KPI tiles, status pills, modals, portaled row menus, alert banner.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ago, type AdminAlert } from './lib.ts';

export function Card({ title, sub, action, children, className = '' }: {
  title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`min-w-0 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-ink pb-2">
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
  good: 'bg-[color-mix(in_oklab,var(--fill)_10%,transparent)] text-fill ring-1 ring-inset ring-[color-mix(in_oklab,var(--fill)_24%,transparent)]',
  warn: 'bg-[color-mix(in_oklab,var(--ahead)_10%,transparent)] text-ahead ring-1 ring-inset ring-[color-mix(in_oklab,var(--ahead)_28%,transparent)]',
  bad: 'bg-[color-mix(in_oklab,var(--limit)_10%,transparent)] text-limit ring-1 ring-inset ring-[color-mix(in_oklab,var(--limit)_28%,transparent)]',
  info: 'bg-[color-mix(in_oklab,var(--s1)_10%,transparent)] text-[var(--s1)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--s1)_25%,transparent)]',
  neutral: 'bg-band text-muted',
};
/** Status pill: always text, never colour alone. */
export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function EffortBadge({ effort }: { effort: string | null }) {
  if (!effort || effort === 'unspecified') return <span className="text-xs text-muted">Standard</span>;
  const tone: Tone = effort === 'xhigh' ? 'bad' : effort === 'high' ? 'warn' : 'neutral';
  return <Pill tone={tone}>{effort}</Pill>;
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

export function Chips<T extends string>({ value, onChange, options, label = 'Filter' }: {
  value: T; onChange: (v: T) => void; options: [T, string, number?][]; label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(([v, text, n]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={`rounded-full border px-3 py-1 text-sm ${value === v ? 'border-ink bg-ink text-paper' : 'border-rule bg-card text-ink/85 hover:text-ink'}`}>
          {text}{n !== undefined && <span className={`ml-1.5 ${value === v ? 'text-paper/85' : 'text-muted'}`}>{n}</span>}
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

export function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-ink" style={{ background: `color-mix(in oklab, ${color} 30%, var(--card))`, boxShadow: `inset 0 0 0 2px ${color}` }} aria-hidden>{initials}</span>;
}

/** Native <dialog> modal with Escape/backdrop close and focus management. */
export function Modal({ open, onClose, title, sub, children }: {
  open: boolean; onClose: () => void; title: string; sub?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="modal-dialog"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-rule px-6 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
        </div>
        <button
          type="button"
          aria-label="Close modal"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted hover:bg-band hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="px-6 py-5">{children}</div>
    </dialog>
  );
}

/**
 * Portaled row action menu (renders to document.body with fixed positioning and auto-flip).
 * Never clipped by overflow-x-auto table containers.
 */
export function RowMenu({ label, items }: { label: string; items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const updatePosition = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const menuWidth = 224;
    const estHeight = items.length * 36 + 16;
    const openUp = r.bottom + estHeight + 12 > window.innerHeight && r.top > estHeight + 12;
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, r.right - menuWidth));
    const top = openUp ? r.top - 6 : r.bottom + 6;
    setPos({ top, left, openUp });
  };

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    const onScrollOrResize = () => {
      const btn = btnRef.current;
      if (!btn) { setOpen(false); return; }
      const r = btn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
      updatePosition();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  return (
    <div className="inline-block">
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-band hover:text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && pos && createPortal(
        <ul
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: 224,
            transform: pos.openUp ? 'translateY(-100%)' : undefined,
          }}
          className="z-50 rounded-lg bg-card py-1 text-sm shadow-[var(--shadow-float)] ring-1 ring-rule"
        >
          {items.map((i) => (
            <li key={i.label} role="none">
              <button
                role="menuitem"
                onClick={() => { setOpen(false); i.onClick(); }}
                className={`block w-full px-3.5 py-2 text-left hover:bg-band ${i.danger ? 'text-limit' : 'text-ink'}`}
              >
                {i.label}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}

/** High-visibility persistent alert banner for unacknowledged critical/warning alerts. */
export function AlertBanner({ alerts, onAck, onInspect }: {
  alerts: AdminAlert[];
  onAck: (id: number) => Promise<void>;
  onInspect: (a: AdminAlert) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  if (!alerts.length) return null;
  const critical = alerts.some((a) => a.severity === 'critical');
  const first = alerts[0];
  const ack = async (id: number) => {
    setBusyId(id);
    try { await onAck(id); } finally { setBusyId(null); }
  };

  return (
    <div
      role="region"
      aria-label="Active admin alerts"
      className={`border-b ${critical
        ? 'border-[color-mix(in_oklab,var(--limit)_45%,var(--rule))] bg-[color-mix(in_oklab,var(--limit)_12%,var(--card))]'
        : 'border-[color-mix(in_oklab,var(--ahead)_45%,var(--rule))] bg-[color-mix(in_oklab,var(--ahead)_12%,var(--card))]'}`}
    >
      <div className="mx-auto w-full max-w-[1440px] px-4 py-3 sm:px-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`mt-0.5 shrink-0 ${critical ? 'text-limit' : 'text-ahead'}`} aria-hidden>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium text-paper ${critical ? 'bg-limit' : 'bg-ahead'}`}>
                  {alerts.length} active alert{alerts.length === 1 ? '' : 's'}
                </span>
                <span className="truncate">{first.title}</span>
                {first.occurrences > 1 && <span className="text-xs font-normal text-muted">({first.occurrences}×)</span>}
              </p>
              <p className="mt-0.5 text-xs text-muted">{first.message} · {ago(first.lastSeenAt)}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {alerts.length > 1 && (
              <button type="button" onClick={() => setExpanded((v) => !v)}
                className="rounded-md border border-rule bg-card px-2.5 py-1 text-xs font-medium hover:bg-band">
                {expanded ? 'Hide list' : `View all ${alerts.length}`}
              </button>
            )}
            <button type="button" onClick={() => onInspect(first)}
              className="rounded-md border border-rule bg-card px-2.5 py-1 text-xs font-medium hover:bg-band">
              Inspect
            </button>
            <button type="button" disabled={busyId === first.id} onClick={() => ack(first.id)}
              className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-paper disabled:opacity-50">
              {busyId === first.id ? 'Saving…' : 'Acknowledge'}
            </button>
          </div>
        </div>

        {expanded && alerts.length > 1 && (
          <ul className="mt-3 divide-y divide-rule border-t border-rule pt-2">
            {alerts.slice(1).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <span className="mr-2"><Pill tone={a.severity === 'critical' ? 'bad' : 'warn'}>{a.severity}</Pill></span>
                  <span className="font-medium">{a.title}</span>
                  {a.occurrences > 1 && <span className="ml-1.5 text-muted">({a.occurrences}×)</span>}
                  <span className="ml-2 text-muted">{ago(a.lastSeenAt)}</span>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => onInspect(a)} className="rounded border border-rule bg-card px-2 py-0.5 hover:bg-band">Inspect</button>
                  <button type="button" disabled={busyId === a.id} onClick={() => ack(a.id)} className="rounded bg-ink px-2 py-0.5 text-paper disabled:opacity-50">Acknowledge</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function PageHead({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
        <p className="mt-1 text-sm text-muted">{sub}</p>
      </div>
      {action}
    </div>
  );
}

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
