# syntax=docker/dockerfile:1

# ---- build: pnpm monorepo -> standalone runtime in /out ----
# Full image, not slim: node-pty/better-sqlite3 compile with node-gyp and need
# python3/make/g++, already included here.
FROM node:22-bookworm AS build
RUN corepack enable
# Electron binary only launches desktop app from repository.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /src

# pnpm store depends only on lockfile: this step stays cached while dependencies
# remain unchanged, regardless of code copied afterward.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

ARG SILLAGE_VERSION=dev
RUN SILLAGE_VERSION=$SILLAGE_VERSION pnpm build \
 && SILLAGE_VERSION=$SILLAGE_VERSION node scripts/stage-runtime.mjs /out \
# --legacy-peer-deps: Claude SDK declares zod@^4 peer while project uses Zod 3;
# pnpm tolerates this mismatch, strict npm resolution does not.
 && cd /out && npm install --omit=dev --legacy-peer-deps \
# Optional packages contain only the `claude` binary, 263 MB per architecture.
# Runner always supplies `pathToClaudeCodeExecutable`, resolved to system or
# Sillage-installed CLI, bypassing SDK internal resolution; this binary is unused.
 && rm -rf /out/node_modules/@anthropic-ai/claude-agent-sdk-*

# ---- runtime ----
FROM node:22-bookworm-slim

# git is essential (worktrees, diffs); tini reaps PTY children.
#
# Agent CLIs are not bundled: at 263/347 MB they made up 73% of image size,
# increasing with each CLI. Sillage installs on demand through interface into
# data directory, already a volume surviving container replacement. Users install
# only what they use. Base-image npm performs installation.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/*

# Base-image `node` user (uid 1000) suffices: agents need a real account with
# writable HOME for credentials.
USER node
RUN mkdir -p /home/node/.local/share/sillage /home/node/.config/sillage \
             /home/node/.claude /home/node/.codex /home/node/.local/share/opencode /home/node/.grok \
             /home/node/workspace

ENV NODE_ENV=production \
    SILLAGE_HOST=0.0.0.0 \
    SILLAGE_WEB_ROOT=/app/web \
    SILLAGE_UPDATE_CHANNEL=docker

WORKDIR /app
COPY --from=build --chown=node:node /out /app

EXPOSE 7317
ENTRYPOINT ["tini", "--"]
CMD ["node", "--max-old-space-size=512", "/app/server/main.js"]
