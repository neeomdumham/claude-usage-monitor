#!/bin/sh
# otelHeadersHelper: authenticates Claude Code's telemetry export with this device's monitoring credential.
printf '{"Authorization":"Bearer %s"}\n' "$(cat "$(dirname "$0")/../token")"
