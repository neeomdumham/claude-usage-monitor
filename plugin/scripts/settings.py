"""Python twin of settings.cjs (used when neither node nor macOS osascript is available)."""
import json, os, sys

ENV_KEYS = {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "1",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT": "1",
}
ENDPOINT_KEY = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def write(p, t):
    with open(p + ".tmp", "w", encoding="utf-8") as f:
        f.write(t)
    os.chmod(p + ".tmp", 0o600)
    os.replace(p + ".tmp", p)


def main(op, settings_path, data_dir=None, endpoint=None):
    raw = read(settings_path)
    s = json.loads(raw) if raw else {}
    if op == "token":
        return (s.get("env") or {}).get("CLAUDE_CODE_OAUTH_TOKEN", "")
    status_cmd, headers_cmd = data_dir + "/bin/statusline.sh", data_dir + "/bin/otel-headers.sh"
    before = json.dumps(s, sort_keys=True)
    if op == "merge":
        env = s.setdefault("env", {})
        env.update(ENV_KEYS)
        env[ENDPOINT_KEY] = endpoint
        s["otelHeadersHelper"] = headers_cmd
        cur = s.get("statusLine")
        if not cur or cur.get("command") != status_cmd:
            write(data_dir + "/prev_statusline", cur["command"] if cur and cur.get("type") == "command" else "")
            s["statusLine"] = {**(cur or {}), "type": "command", "command": status_cmd}
    elif op == "unmerge":
        env = s.get("env")
        if env is not None:
            for k in [*ENV_KEYS, ENDPOINT_KEY]:
                env.pop(k, None)
            if not env:
                del s["env"]
        if s.get("otelHeadersHelper") == headers_cmd:
            del s["otelHeadersHelper"]
        if (s.get("statusLine") or {}).get("command") == status_cmd:
            prev = read(data_dir + "/prev_statusline")
            if prev:
                s["statusLine"]["command"] = prev
            else:
                del s["statusLine"]
    else:
        raise SystemExit("unknown op " + op)
    if json.dumps(s, sort_keys=True) == before:
        return "unchanged"
    if raw and read(settings_path + ".usage-monitor-backup") is None:
        write(settings_path + ".usage-monitor-backup", raw)
    write(settings_path, json.dumps(s, indent=2) + "\n")
    return "changed"


if __name__ == "__main__":
    sys.stdout.write(main(*sys.argv[1:]))
