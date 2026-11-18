export type Meter = {
  meterKey: string; label: string | null; usedPercentage: number; resetsAt: number;
  observedAt: string; source: string; expired: boolean; stale: boolean;
};
export type Row = {
  personId: number | null; installationId: number | null; name: string; requests: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  estCostUsd: number; tokens: string[]; sharedTokens: string[]; quotaContribution: null;
};
export type Installation = {
  id: number; name: string; personId: number | null; hostname: string | null; os: string | null;
  joinedIp: string | null; joinedAt: string; lastHeartbeatAt: string | null; clientVersion: string | null;
  appliedPolicyRevision: number | null; queueDepth: number; droppedCount: number; revoked: boolean;
  capabilities: Record<string, boolean>;
};
export type Person = {
  id: number; name: string; createdAt: string; gitEmails: string[];
  openInvite: { expiresAt: string; uses: number; maxUses: number } | null;
};
export type PolicyData = {
  batchIntervalSec: number; heartbeatIntervalSec: number; policyRefreshSec: number;
  retentionDays: number; freshnessThresholdSec: number; displayTimezone: string;
  workNamespaces: string[]; flagOutsideWorkPct: number; flagNightPct: number;
  flagSpikeMultiple: number; flagSdkPct: number; flagBypassPct: number; flagNoRepoPct: number;
  capturePrompts: boolean; captureToolDetails: boolean; captureFileContent: boolean; captureErrors: boolean;
  captureGitDetails: boolean; contentRetentionDays: number;
};
export type ContentKind = 'prompt' | 'command' | 'tool_input' | 'error' | 'file_read' | 'file_write' | 'diff' | 'output';
export type ContentItem = {
  id: number; eventTime: string; kind: ContentKind; sessionId: string | null; repo: string | null; toolName: string | null;
  filePath: string | null; branch: string | null; text: string; truncated: boolean;
  installationId: number; device: string; personId: number | null; person: string | null;
};
export type Commit = {
  repo: string; sha: string; authorEmail: string; committedAt: string; additions: number; deletions: number;
  message: string | null; diff: string | null; personId: number | null; person: string | null;
};
export type Overview = {
  policy: { revision: number; data: PolicyData };
  meters: Meter[]; window: string; ranking: Row[] | null; installations: Installation[]; people: Person[];
  latestPluginVersion: string | null;
};
export type Flag = {
  key: string; pid: number; person: string; severity: 'alert' | 'watch'; title: string; evidence: string; caveat: string;
  review?: { note: string; at: string } | null;
};
export type ModelRow = {
  model: string; calls: number; input: number; output: number; cacheRead: number; cacheCreation: number; cost: number;
  people: { pid: number; cost: number; calls: number }[];
};
export type AuditEvent = {
  id: number; at: string; actor: 'owner' | 'device' | 'system'; action: string;
  personId: number | null; person: string | null; installationId: number | null; device: string | null;
  details: Record<string, any>;
};

/** One readable line per audit entry. Details only ever hold ids, names and counts. */
// Entries before 0.5.2 hold GitLab's counts at the top level; later ones nest them per source.
const syncParts = (d: any) => {
  const parts = [];
  const gl = d.gitlab ?? (d.projects !== undefined ? d : null);
  if (gl) parts.push(`GitLab ${gl.projects} projects, ${gl.commits} new commits`);
  if (d.github) parts.push(`GitHub ${d.github.repos} repos, ${d.github.commits} new commits`);
  return parts.join('; ');
};

export function describeAudit(e: AuditEvent): string {
  const d = e.details ?? {}, who = e.person ?? 'Someone', dev = e.device ?? d.device ?? 'a device';
  switch (e.action) {
    case 'auth.login': return 'Owner signed in';
    case 'auth.login_failed': return `Failed owner sign-in${d.ip ? ` from ${d.ip}` : ''}`;
    case 'person.added': return `${d.name ?? who} added`;
    case 'person.renamed': return `${d.from} renamed to ${d.to}`;
    case 'person.git_emails': return `${who}: commit emails updated (${d.emails})`;
    case 'invite.created': return `Invite link created for ${who}`;
    case 'invite.cancelled': return `Invite link for ${who} cancelled`;
    case 'device.joined': return `${who} joined from ${d.hostname ?? 'a device'}${d.os ? ` (${d.os})` : ''}`;
    case 'device.join_failed': return `Rejected a join attempt${d.ip ? ` from ${d.ip}` : ''}`;
    case 'device.removed': return `${dev} removed${e.person ? ` (${who})` : ''}`;
    case 'device.restored': return `${dev} restored${e.person ? ` (${who})` : ''}`;
    case 'device.renamed': return `Device ${d.from} renamed to ${d.to}`;
    case 'prompt.labelled': return `${who}: a prompt was labelled ${d.category}`;
    case 'flag.reviewed': return `${who}: flag reviewed${d.note ? `, "${d.note}"` : ''}`;
    case 'settings.changed': return `Settings changed: ${(d.changed ?? []).join(', ') || 'no fields'}`;
    case 'reading.entered': return `Reading entered by hand: ${d.meter} ${d.pct}%`;
    case 'git.sync': return `Commit sync: ${syncParts(d)}`;
    case 'git.sync_failed': return `Commit sync failed: ${(d.errors ?? [d.error]).join('; ')}${syncParts(d) ? ` (saved: ${syncParts(d)})` : ''}`;
    default: return e.action;
  }
}

/** 'plugin-0.2.0' < '0.3.0' */
export function isOutdated(clientVersion: string | null, latest: string | null) {
  if (!clientVersion || !latest) return false;
  const a = clientVersion.replace(/^plugin-/, '').split('.').map(Number), b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

export type PersonStatus = { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral'; key: 'active' | 'quiet' | 'invited' | 'notset' | 'removed' };
export function personStatus(p: Person, devices: Installation[]): PersonStatus {
  const mine = devices.filter((d) => d.personId === p.id), live = mine.filter((d) => !d.revoked);
  if (!live.length) {
    if (p.openInvite) return { label: 'Invited', tone: 'info', key: 'invited' };
    return mine.length ? { label: 'Removed', tone: 'neutral', key: 'removed' } : { label: 'Not set up', tone: 'warn', key: 'notset' };
  }
  const last = Math.max(0, ...live.map((d) => (d.lastHeartbeatAt ? Date.parse(d.lastHeartbeatAt) : 0)));
  if (!last) return { label: 'Joined', tone: 'info', key: 'active' };
  return Date.now() - last < 7 * 86400_000 ? { label: 'Active', tone: 'good', key: 'active' } : { label: 'Quiet', tone: 'neutral', key: 'quiet' };
}
export const lastSeen = (devices: Installation[]) => {
  const t = Math.max(0, ...devices.filter((d) => d.lastHeartbeatAt).map((d) => Date.parse(d.lastHeartbeatAt!)));
  return t ? new Date(t).toISOString() : null;
};
export type PersonStats = {
  pid: number; name: string; isPerson: boolean;
  requests: number; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; cacheHit: number;
  sessions: number; activeDays: number; nightPct: number; sdkPct: number; subagentPct: number; topModel: string | null;
  repoCost: { work: number; outside: number; none: number };
  prompts: number; avgPromptLength: number; toolCalls: number; toolFailures: number;
  decisions: number; bypassPct: number; compactions: number; apiErrors: number;
  labels: Record<string, number>;
  claude: { commits: number; prs: number; added: number; removed: number; activeUserSec: number; activeCliSec: number; editsAccepted: number; editsRejected: number };
  gitlab: { commits: number; additions: number; deletions: number };
  overlaps: number; sharedTokens: { fp: string; other: string }[];
};
type ByPid = { pid: number; key: string; n: number };
export type Analytics = {
  range: { key: string; start: string; end: string }; timezone: string;
  people: PersonStats[]; flags: Flag[];
  burn: { meterKey: string; pct: number; resetsAt: number; t0: number; t1: number }[];
  daily: { day: string; pid: number; cost: number; requests: number }[];
  models: ModelRow[];
  repos: {
    repo: string | null; class: 'work' | 'outside' | 'none'; cost: number; requests: number; sessions: number;
    people: { pid: number; cost: number }[];
    claude: { commits: number; prs: number; added: number; removed: number };
    gitlab: { commits: number; additions: number; deletions: number; authors: number };
  }[];
  activity: {
    heatmap: { dow: number; hour: number; requests: number }[];
    tools: { tool: string; calls: number; failures: number; p50: number | null; p95: number | null }[];
    permissionModes: ByPid[]; entrypoints: ByPid[]; querySources: ByPid[];
    errors: { status: string; n: number }[]; subagents: { agent: string; n: number }[];
  };
  git: {
    // `gitlab*` fields cover every server-synced commit: GitLab group and GitHub organization.
    gitlabConfigured: boolean; lastSync: string | null;
    claudeDaily: { day: string; pid: number; commits: number; prs: number; added: number; removed: number }[];
    gitlabDaily: { day: string; pid: number | null; commits: number }[];
    edits: { tool: string; accepted: number; rejected: number }[];
    unmappedAuthors: { email: string; commits: number }[];
  };
};

/** Colour follows the person, never their rank: slot by stable id order. ponytail: >8 people fold to muted. */
export function personColors(pids: number[]) {
  const sorted = [...new Set(pids)].sort((a, b) => a - b);
  return (pid: number | null) => {
    const i = pid === null ? -1 : sorted.indexOf(pid);
    return i >= 0 && i < 8 ? `var(--s${i + 1})` : 'var(--muted)';
  };
}
export const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
/** Every local day from start to end, as YYYY-MM-DD in the display timezone. */
export function daysBetween(startIso: string, endIso: string, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const out: string[] = [];
  const end = Math.min(Date.parse(endIso), Date.now());
  for (let t = Date.parse(startIso); t <= end; t += 86400_000) {
    const d = fmt.format(t);
    if (out[out.length - 1] !== d) out.push(d);
  }
  const last = fmt.format(end);
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
export type Profile = {
  person: { id: number; name: string }; days: number; timezone: string;
  totals: { requests: number; cost: number; outputTokens: number };
  hours: { dow: number; hour: number; requests: number }[];
  repos: { repo: string | null; class: 'work' | 'outside' | 'none'; requests: number; cost: number }[];
  repoShare: Record<'work' | 'outside' | 'none', number>; workNamespacesSet: boolean;
  models: { model: string; effort: string | null; requests: number; cost: number }[];
  querySources: { source: string; requests: number; cost: number }[];
  tools: { tool: string; calls: number; failures: number }[];
  permissionModes: { mode: string; n: number }[];
  compactions: { trigger: string; n: number }[];
  prompts: { count: number; avgLength: number };
  subagents: { agent: string; n: number }[];
  apiErrors: { status: string; n: number }[];
  flags: Flag[];
};

// Keep in sync with plugin/.claude-plugin and the repo-root marketplace manifest.
export const MARKETPLACE_URL = 'https://gitlab.com/moeen-mahmud/claude-usage-monitor.git';
export const TRANSPARENCY_URL = 'https://gitlab.com/moeen-mahmud/claude-usage-monitor/-/blob/main/TRANSPARENCY.md';
export const inviteLink = (token: string, origin = window.location.origin) => `${origin}/join#${token}`;
export const installCommand = (link: string) =>
  `claude plugin install usage-monitor --marketplace ${MARKETPLACE_URL} --config 'invite=${link}'`;

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
