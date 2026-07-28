# syntax=docker/dockerfile:1

# ---- build : monorepo pnpm -> arbre d'exécution autonome dans /out ----
# Image complète (pas slim) : node-pty et better-sqlite3 compilent via node-gyp
# et ont besoin de python3/make/g++, déjà présents ici.
FROM node:22-bookworm AS build
RUN corepack enable
WORKDIR /src

# Le store pnpm ne dépend que du lockfile : cette étape reste en cache tant que
# les dépendances ne bougent pas, quel que soit le code copié ensuite.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

ARG SILLAGE_VERSION=dev
RUN SILLAGE_VERSION=$SILLAGE_VERSION pnpm build \
 && SILLAGE_VERSION=$SILLAGE_VERSION node scripts/stage-runtime.mjs /out \
# --legacy-peer-deps : le SDK Claude déclare un peer zod@^4 alors que le projet
# est en zod 3 ; pnpm tolère cet écart, la résolution stricte de npm non.
 && cd /out && npm install --omit=dev --legacy-peer-deps

# ---- runtime ----
FROM node:22-bookworm-slim

# git est indispensable (worktrees, diffs) ; tini récolte les enfants des PTY ;
# les CLIs agents sont préinstallés, l'utilisateur ne monte que ses credentials.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code @openai/codex

# L'utilisateur `node` (uid 1000) de l'image de base fait l'affaire : les agents
# ont besoin d'un vrai compte avec un HOME inscriptible pour leurs credentials.
USER node
RUN mkdir -p /home/node/.local/share/sillage /home/node/.config/sillage \
             /home/node/.claude /home/node/.codex /home/node/workspace

ENV NODE_ENV=production \
    SILLAGE_HOST=0.0.0.0 \
    SILLAGE_WEB_ROOT=/app/web \
    SILLAGE_UPDATE_CHANNEL=docker

WORKDIR /app
COPY --from=build --chown=node:node /out /app

EXPOSE 7317
ENTRYPOINT ["tini", "--"]
CMD ["node", "--max-old-space-size=512", "/app/server/main.js"]
