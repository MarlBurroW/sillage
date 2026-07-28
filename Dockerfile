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
# architecture. Le runner passe toujours `pathToClaudeCodeExecutable`, résolu sur
# le CLI du système ou sur celui que Sillage a installé, donc la résolution interne
# du SDK n'est jamais consultée et ce binaire ne servirait à rien.
 && rm -rf /out/node_modules/@anthropic-ai/claude-agent-sdk-*

# ---- runtime ----
FROM node:22-bookworm-slim

# git est indispensable (worktrees, diffs) ; tini récolte les enfants des PTY.
#
# Les CLI agents ne sont pas dans l'image. Ils pèsent 263 et 347 Mo, ce qui en
# faisait 73 % du poids, et chaque CLI ajouté aurait creusé l'écart. Sillage les
# installe à la demande depuis l'interface, dans le répertoire de données : c'est
# déjà un volume, donc ils survivent au remplacement du conteneur, et l'utilisateur
# n'installe que ceux dont il se sert. npm, fourni par l'image de base, est ce qui
# les pose.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/*

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
