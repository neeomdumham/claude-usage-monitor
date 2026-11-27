"""Python twin of settings.cjs (used when neither node nor macOS osascript is available)."""
import json, os, sys

ENV_KEYS = {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "delta",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "1",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT": "1",
    "OTEL_LOG_ASSISTANT_RESPONSES": "0",
}
CAPTURE_ENV = {
    "prompts": {"OTEL_LOG_USER_PROMPTS": "1"},
    "tools": {"OTEL_LOG_TOOL_DETAILS": "1"},
    "content": {
        "OTEL_LOG_TOOL_DETAILS": "1", "OTEL_LOG_TOOL_CONTENT": "1", "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
        "OTEL_TRACES_EXPORTER": "otlp", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/json",
    },
}
TRACES_ENDPOINT_KEY = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
CAPTURE_KEYS = [TRACES_ENDPOINT_KEY] + [k for env in CAPTURE_ENV.values() for k in env]
ENDPOINT_KEY = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
METRICS_ENDPOINT_KEY = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
MARKETPLACE = "usage-monitor-tools"


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


def marketplace_auto_update(s, on, settings_path, data_dir):
    """Same as marketplaceAutoUpdate in settings.cjs."""
    ekm = s.get("extraKnownMarketplaces") or {}
    cur = ekm.get(MARKETPLACE)
    owned_file = data_dir + "/declared_marketplace"
    if on:
        known = None
        try:
            known_path = os.path.join(os.path.dirname(settings_path), "plugins", "known_marketplaces.json")
            known = (json.loads(read(known_path) or "{}").get(MARKETPLACE) or {}).get("source")
        except ValueError:
            pass
        if not cur and not known:
            return
        if not cur:
            write(owned_file, "1")
        owned = read(owned_file) == "1"
        ekm[MARKETPLACE] = {**(cur or {}), **({"source": known} if owned and known else {}), "autoUpdate": True}
        s["extraKnownMarketplaces"] = ekm
    elif cur:
        if read(owned_file) == "1":
            del ekm[MARKETPLACE]
            write(owned_file, "")
        else:
            cur.pop("autoUpdate", None)
        if not ekm:
            del s["extraKnownMarketplaces"]


def main(op, settings_path, data_dir=None, endpoint=None, capture="", auto_update=""):
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
        base = endpoint[: -len("/v1/logs")] if endpoint.endswith("/v1/logs") else endpoint
        env[METRICS_ENDPOINT_KEY] = base + "/v1/metrics"
        for k in CAPTURE_KEYS:
            env.pop(k, None)
        for c in (capture or "").split(","):
            env.update(CAPTURE_ENV.get(c, {}))
            if c == "content":
                env[TRACES_ENDPOINT_KEY] = base + "/v1/traces"
        s["otelHeadersHelper"] = headers_cmd
        cur = s.get("statusLine")
        if not cur or cur.get("command") != status_cmd:
            write(data_dir + "/prev_statusline", cur["command"] if cur and cur.get("type") == "command" else "")
            s["statusLine"] = {**(cur or {}), "type": "command", "command": status_cmd}
        marketplace_auto_update(s, auto_update == "1", settings_path, data_dir)
    elif op == "unmerge":
        env = s.get("env")
        if env is not None:
            for k in [*ENV_KEYS, ENDPOINT_KEY, METRICS_ENDPOINT_KEY, *CAPTURE_KEYS]:
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
        marketplace_auto_update(s, False, settings_path, data_dir)
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
