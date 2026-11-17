// Edits Claude Code user settings for the usage-monitor plugin.
// Runs under Node (`node settings.cjs ...`) or macOS JXA (`osascript -l JavaScript settings.cjs ...`).
// Ops:
//   merge   <settings.json> <dataDir> <logsEndpoint> [capture]  -> prints "changed" | "unchanged"
//           capture: comma list of what the admin switched on (prompts,tools,content); absent ones are removed
//   unmerge <settings.json> <dataDir>                 -> prints "changed" | "unchanged"
//   token   <settings.json>                           -> prints env.CLAUDE_CODE_OAUTH_TOKEN raw, for piping into a hash only
const ENV_KEYS = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp', // commits, PRs, lines and active time Claude Code counts
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
  // Tag events with the git remote and entrypoint.
  OTEL_METRICS_INCLUDE_REPOSITORY: '1',
  OTEL_METRICS_INCLUDE_ENTRYPOINT: '1',
  OTEL_LOG_ASSISTANT_RESPONSES: '0', // Claude's replies are never sent, even when prompt capture is on
};
// Content capture, set only while the admin has the matching policy switch on (the server drops it otherwise).
const CAPTURE_ENV = {
  prompts: { OTEL_LOG_USER_PROMPTS: '1' },
  tools: { OTEL_LOG_TOOL_DETAILS: '1' },
  content: {
    OTEL_LOG_TOOL_DETAILS: '1', OTEL_LOG_TOOL_CONTENT: '1', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
  },
};
const TRACES_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
const CAPTURE_KEYS = [TRACES_ENDPOINT_KEY].concat(...Object.keys(CAPTURE_ENV).map((k) => Object.keys(CAPTURE_ENV[k])));
const ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';
const METRICS_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT';

function main(argv, io) {
  const [op, settingsPath, dataDir, endpoint, capture] = argv;
  const raw = io.read(settingsPath);
  const s = raw ? JSON.parse(raw) : {};
  if (op === 'token') return (s.env && s.env.CLAUDE_CODE_OAUTH_TOKEN) || '';

  const statusCmd = dataDir + '/bin/statusline.sh';
  const headersCmd = dataDir + '/bin/otel-headers.sh';
  const before = JSON.stringify(s);

  if (op === 'merge') {
    s.env = s.env || {};
    for (const k in ENV_KEYS) s.env[k] = ENV_KEYS[k];
    s.env[ENDPOINT_KEY] = endpoint;
    s.env[METRICS_ENDPOINT_KEY] = endpoint.replace(/\/v1\/logs$/, '/v1/metrics');
    for (const k of CAPTURE_KEYS) delete s.env[k];
    for (const c of String(capture || '').split(',')) {
      if (!CAPTURE_ENV[c]) continue;
      for (const k in CAPTURE_ENV[c]) s.env[k] = CAPTURE_ENV[c][k];
      if (c === 'content') s.env[TRACES_ENDPOINT_KEY] = endpoint.replace(/\/v1\/logs$/, '/v1/traces');
    }
    s.otelHeadersHelper = headersCmd;
    const cur = s.statusLine;
    if (!cur || cur.command !== statusCmd) {
      // Remember the user's own status line so ours can chain it (and uninstall can restore it).
      io.write(dataDir + '/prev_statusline', cur && cur.type === 'command' ? cur.command : '');
      s.statusLine = Object.assign({}, cur || {}, { type: 'command', command: statusCmd });
    }
  } else if (op === 'unmerge') {
    if (s.env) {
      for (const k in ENV_KEYS) delete s.env[k];
      delete s.env[ENDPOINT_KEY];
      delete s.env[METRICS_ENDPOINT_KEY];
      for (const k of CAPTURE_KEYS) delete s.env[k];
      if (!Object.keys(s.env).length) delete s.env;
    }
    if (s.otelHeadersHelper === headersCmd) delete s.otelHeadersHelper;
    if (s.statusLine && s.statusLine.command === statusCmd) {
      const prev = io.read(dataDir + '/prev_statusline');
      if (prev) s.statusLine.command = prev;
      else delete s.statusLine;
    }
  } else {
    throw new Error('unknown op ' + op);
  }

  if (JSON.stringify(s) === before) return 'unchanged';
  if (raw && !io.read(settingsPath + '.usage-monitor-backup')) io.write(settingsPath + '.usage-monitor-backup', raw);
  io.write(settingsPath, JSON.stringify(s, null, 2) + '\n');
  return 'changed';
}

if (typeof require === 'function' && typeof process !== 'undefined') {
  const fs = require('fs');
  const io = {
    read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    write: (p, t) => { fs.writeFileSync(p + '.tmp', t, { mode: 0o600 }); fs.renameSync(p + '.tmp', p); },
  };
  process.stdout.write(main(process.argv.slice(2), io));
}

// JXA entry point (osascript calls run(argv); its return value goes to stdout).
function run(argv) {
  ObjC.import('Foundation');
  const io = {
    read: (p) => {
      const t = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
      return t.isNil() ? null : ObjC.unwrap(t);
    },
    write: (p, t) => { $(t).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null); },
  };
  return main(argv, io);
}
