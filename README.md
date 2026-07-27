# Sillage

Plateforme de développement agentique self-hosted et multi-CLI. Une UI web, pensée
mobile d'abord, pour piloter Claude Code et Codex sur ses projets depuis n'importe où.

La spec complète est dans [docs/SPEC.md](docs/SPEC.md).

## État

Utilisable au quotidien. Les deux adaptateurs (Claude Code et Codex) sont en place, avec
le chat, les appels d'outils, les permissions interactives, la recherche plein texte, un
panneau IDE (explorateur, éditeur, diffs, terminaux) et la PWA mobile.

## Prérequis

- Node 22 ou plus
- pnpm 9
- `claude` et `codex` installés et déjà authentifiés sur la machine hôte

## Démarrage en développement

```bash
pnpm install
pnpm db:generate          # seulement après avoir modifié packages/db/src/schema.ts
pnpm user:create          # crée le premier compte, administrateur d'office
pnpm dev                  # API sur :7317, UI Vite sur :5317 avec proxy /api
```

## Production

```bash
pnpm build
cp deploy/config.example.toml ~/.config/sillage/config.toml
cp deploy/sillage.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now sillage
loginctl enable-linger $USER   # pour que le daemon survive à la déconnexion
```

Le daemon sert alors l'UI buildée et l'API sur le même port.

Deux points qui se paient cher si on les oublie :

- Le `PATH` d'une unité systemd est minimal et n'inclut pas `~/.local/bin`, où vivent
  généralement `claude` et `codex`. L'unité fournie le complète explicitement ; sans ça,
  chaque conversation échoue au lancement du CLI. Si tes binaires sont ailleurs, ajuste
  la ligne `Environment=PATH=` ou renseigne un chemin absolu dans `agents.*.binary`.
- Ne lance pas le daemon avec un simple `node ... &` depuis un terminal : il reçoit un
  `SIGTERM` à la fermeture du shell. C'est systemd qui doit le superviser.

## Sécurité

Sillage est conçu pour un cercle de confiance, pas pour un accès public :

- Les agents tournent sous ton compte utilisateur, avec tes credentials Claude et Codex.
  Tous les utilisateurs de l'instance consomment donc ton abonnement.
- Le mode terminal (lot 5) donne un shell complet sous ce même compte.
- Il n'y a pas d'isolation système entre utilisateurs. Un projet partagé est lisible par
  tous les comptes de l'instance.

Le serveur écoute sur `127.0.0.1` par défaut et ne gère pas TLS. Pour y accéder à
distance, passe par un reverse proxy (Caddy) ou un tunnel (Tailscale, Cloudflare Tunnel).
Ne l'expose jamais directement sur Internet.

## Structure

```
apps/server      daemon Fastify : API, WebSocket, supervision des CLI
apps/web         UI React, PWA
packages/protocol schéma d'événements et types partagés
packages/db      schéma Drizzle et migrations
deploy/          unité systemd et configuration d'exemple
```

## Licence

MIT, voir [LICENSE](LICENSE).
