export type Meter = {
  meterKey: string; label: string | null; usedPercentage: number; resetsAt: number;
  observedAt: string; source: string; expired: boolean; stale: boolean;
};
export type Row = {
  credentialId: number | null; installationId: number | null; label: string | null;
  installationName: string | null; fingerprintPrefix: string | null; requests: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  estCostUsd: number; quotaContribution: null;
};
export type Installation = {
  id: number; name: string; lastHeartbeatAt: string | null; appliedPolicyRevision: number | null;
  queueDepth: number; droppedCount: number; revoked: boolean; capabilities: Record<string, boolean>;
};
export type PolicyData = {
  batchIntervalSec: number; heartbeatIntervalSec: number; policyRefreshSec: number;
  retentionDays: number; freshnessThresholdSec: number; displayTimezone: string;
};
export type Overview = {
  policy: { revision: number; data: PolicyData };
  meters: Meter[]; window: string; ranking: Row[] | null; installations: Installation[];
};

export async function call<T = any>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Upstream window lengths; anything weekly-shaped (e.g. seven_day_fable) shares the 7-day length. */
export function windowSeconds(meterKey: string): number | null {
  if (meterKey === 'five_hour') return 5 * 3600;
  if (meterKey.startsWith('seven_day')) return 7 * 86400;
  return null;
}

export const METER_NAMES: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'This week, all models',
};
export const meterName = (m: Meter) => m.label ?? METER_NAMES[m.meterKey] ?? m.meterKey.replaceAll('_', ' ');

export type Pace = {
  elapsed: number;           // 0..1 of the window that has passed
  projected: number | null;  // linear projection at reset, null when too early to say
  hitsLimitAt: number | null; // epoch seconds, when the projection crosses 100% before reset
};

/** Linear pace from one reading. Deliberately simple: it's a heads-up, not a forecast. */
export function pace(m: Meter, now = Date.now() / 1000): Pace | null {
  const len = windowSeconds(m.meterKey);
  if (!len || m.expired) return null;
  const start = m.resetsAt - len;
  const elapsed = Math.min(1, Math.max(0, (now - start) / len));
  if (elapsed < 0.08 || m.usedPercentage <= 0) return { elapsed, projected: null, hitsLimitAt: null };
  const projected = m.usedPercentage / elapsed;
  const hitsLimitAt = projected > 100 ? start + (100 / m.usedPercentage) * (now - start) : null;
  return { elapsed, projected, hitsLimitAt };
}

export const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function ago(iso: string, now = Date.now()) {
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function until(epoch: number, now = Date.now() / 1000) {
  const s = Math.max(0, epoch - now);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export function clock(epoch: number, tz: string, withDay: boolean) {
  return new Intl.DateTimeFormat('en', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', ...(withDay ? { weekday: 'short' } : {}),
  }).format(epoch * 1000);
}
