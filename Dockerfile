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
 && cd /out && npm install --omit=dev --legacy-peer-deps \
# Ces paquets optionnels ne contiennent que le binaire `claude`, 263 Mo par
# architecture, et l'image l'installe déjà globalement plus bas. Les garder
# doublerait le CLI dans l'image ; c'était le cas, et c'était la copie embarquée
# qui servait tant que le runner laissait le SDK résoudre son exécutable.
 && rm -rf /out/node_modules/@anthropic-ai/claude-agent-sdk-*

# ---- runtime ----
FROM node:22-bookworm-slim

# git est indispensable (worktrees, diffs) ; tini récolte les enfants des PTY ;
# les CLIs agents sont préinstallés, l'utilisateur ne monte que ses credentials.
#
# Versions épinglées, et à bumper à la main. Sans épinglage l'image embarquerait
# le CLI que npm servait le jour du build, et comme cette couche ne dépend ni du
# code ni de SILLAGE_VERSION, le cache de build la fige à une date arbitraire :
# deux images du même tag pourraient tourner sur des CLI différents sans que rien
# ne le dise. Un numéro écrit ici est relisible dans l'historique.
#
# claude-code 2.1.220 est la version que le SDK embarquait
# (@anthropic-ai/claude-agent-sdk 0.3.220), donc l'image ne change pas de
# comportement en passant au CLI du système.
ARG CLAUDE_CODE_VERSION=2.1.220
ARG CODEX_VERSION=0.145.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"

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
