# Plugin test runner: the tools a teammate's Linux device has (sh, dash, curl, node or python3) plus jq/psql to check results.
FROM alpine:3.22
RUN apk add --no-cache curl dash python3 nodejs jq shellcheck postgresql17-client \
 # node lives off PATH so the python3 fallback can be tested; run.sh adds it back for the node runs
 && mkdir -p /opt/node/bin && mv /usr/bin/node /opt/node/bin/node
