# A teammate's Linux machine: real Claude Code, plus curl/git for the plugin and tmux for an interactive session.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git jq tmux \
 && rm -rf /var/lib/apt/lists/* && npm install -g @anthropic-ai/claude-code
USER node
WORKDIR /home/node
