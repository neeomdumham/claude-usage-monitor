// `usage-monitor claude ...`: starts Claude Code with telemetry pointed at the local daemon and
// tags it with the fingerprint of the setup token this launch path actually uses.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadState } from './state.ts';

// Auth sources that outrank CLAUDE_CODE_OAUTH_TOKEN (docs: Authentication precedence).
const OVERRIDING_ENV = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
];

function hasApiKeyHelper(env: NodeJS.ProcessEnv): boolean {
  const dir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  for (const f of ['settings.json', 'settings.local.json']) {
    try { if (JSON.parse(readFileSync(join(dir, f), 'utf8')).apiKeyHelper) return true; } catch {}
  }
  return false;
}

/** Full SHA-256 of the setup token, or null when the active credential can't be verified. */
export function credentialFingerprint(env: NodeJS.ProcessEnv, apiKeyHelper = hasApiKeyHelper(env)): string | null {
  if (OVERRIDING_ENV.some((k) => env[k]) || apiKeyHelper) return null;
  const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return token ? createHash('sha256').update(token).digest('hex') : null;
}

export function telemetryEnv(env: NodeJS.ProcessEnv, otlpPort: number, fp: string | null): NodeJS.ProcessEnv {
  const ours = `monitor.credential_fp=${fp ?? 'unknown'}`;
  return {
    ...env,
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: env.OTEL_METRICS_EXPORTER ?? 'none',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${otlpPort}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: env.OTEL_LOGS_EXPORT_INTERVAL ?? '5000',
    OTEL_RESOURCE_ATTRIBUTES: env.OTEL_RESOURCE_ATTRIBUTES ? `${env.OTEL_RESOURCE_ATTRIBUTES},${ours}` : ours,
  };
}

export function runClaude(args: string[]) {
  const state = loadState();
  const env = telemetryEnv(process.env, state.otlpPort, credentialFingerprint(process.env));
  const child = spawn('claude', args, { stdio: 'inherit', env });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
