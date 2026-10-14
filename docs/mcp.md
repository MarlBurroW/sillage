# Le serveur MCP de Sillage depuis un CLI local

Sillage monte dans chaque conversation un serveur MCP `sillage` qui rend au CLI ce que
la plateforme sait : l'historique, le board, les sessions en cours, la mémoire, et les
gestes qui passent par le daemon (lancer une session, créer une carte, planifier). Ce
même serveur, `apps/server/src/mcp/sillage-mcp.mjs`, se lance à la main depuis un CLI
hors Sillage : un Codex ou un Claude Code ouvert dans un terminal, sur la machine ou
depuis un poste qui s'y connecte en SSH.

Il parle en stdio et lit la base SQLite directement : pas de port, pas de jeton. Son
environnement dit quelle portée il sert.

## Deux portées

| Variable | Mode conversation | Mode global |
|---|---|---|
| `SILLAGE_MCP_DB` | chemin de `sillage.db` | idem |
| `SILLAGE_MCP_PROJECT` | identifiant du projet servi | **absent** |
| `SILLAGE_MCP_USER` | — | nom du compte au nom duquel écrire ; facultatif si la base n'a qu'un compte |
| `SILLAGE_MCP_MEMORY` | dossier de mémoire du projet | racine de la mémoire (`memory/` à côté de la base par défaut) |
| `SILLAGE_MCP_CONVERSATION` | conversation courante, exclue des résultats | — |

**Mode conversation.** C'est celui que Sillage utilise. Les outils sont cadrés au
projet, et les écritures sont signées par la conversation : une note de carte renvoie à
la session, une session lancée reçoit la mission enveloppée, avec qui l'a confiée.

**Mode global.** Sans `SILLAGE_MCP_PROJECT`, le serveur sert toute l'instance :

- un outil de plus, `list_projects`, donne les projets avec leur dossier, leurs sessions
  en train de travailler et leur dernière activité ;
- chaque autre outil prend un paramètre `project` : l'identifiant, le nom exact, ou un
  fragment du nom s'il ne désigne qu'un projet (deviner entre deux écrirait dans le
  mauvais) ; `count_active_sessions` s'en passe, et les outils SILLAGE.md aussi avec
  `scope: global` ;
- `add_card_note` et `update_issue` prennent `card`, le numéro de la carte, à la place
  de celle de la conversation ;
- les écritures sont au nom du compte : la carte créée a cet auteur, la note aussi, la
  session lancée appartient à ce compte et reçoit la mission nue, comme si elle avait
  été tapée dans Sillage ; sans `agent`, elle tourne sous Claude ;
- les outils qui parlent entre sessions ne sont pas proposés (`send_session_message`,
  `broadcast_session_message`, `notify_when_done`, `read_session_messages`, les
  décisions) : un client hors session n'a ni identité pour signer ni tour où recevoir.

Les gestes qui passent par le daemon restent soumis à ses gardes : au plus six
lancements par heure, comptés ensemble pour tout ce qui vient hors session, et le daemon
doit tourner, sinon la demande expire.

## Configuration côté CLI

Les chemins ci-dessous sont ceux d'une installation par le script Linux, où la release
courante est sous `~/.local/share/sillage/app/current` ; le `.mjs` dépend de
`better-sqlite3` compilé pour le Node du daemon, à lancer avec le même `node`.

Codex, dans `~/.codex/config.toml`, sur la machine de Sillage :

```toml
# Serveur MCP de Sillage, toute l'instance, au nom du seul compte de la base
[mcp_servers.sillage]
command = "node"
args = ["/home/USER/.local/share/sillage/app/current/server/mcp/sillage-mcp.mjs"]
env = { SILLAGE_MCP_DB = "/home/USER/.local/share/sillage/sillage.db" }
```

Depuis un autre poste, par SSH (le `PATH` non interactif doit trouver `node`) :

```toml
[mcp_servers.sillage]
command = "ssh"
args = ["marldev", "SILLAGE_MCP_DB=/home/USER/.local/share/sillage/sillage.db SILLAGE_MCP_USER=USER node /home/USER/.local/share/sillage/app/current/server/mcp/sillage-mcp.mjs"]
```

Claude Code, même commande et même environnement :

```bash
claude mcp add --scope user sillage -e SILLAGE_MCP_DB=/home/USER/.local/share/sillage/sillage.db -- node /home/USER/.local/share/sillage/app/current/server/mcp/sillage-mcp.mjs
```

Pour une portée réduite à un projet, ajouter `SILLAGE_MCP_PROJECT` avec l'identifiant du
projet (celui de son URL dans Sillage) : la liste d'outils redevient celle d'une
conversation, sans `list_projects` ni paramètre `project`, mais sans session non plus,
donc sans messages entre sessions.

## Dans le code

- `GLOBAL`, `selectProject` et `globalTools` dans `sillage-mcp.mjs` : le projet est un
  état du process posé au début de chaque appel, et les appels sont traités un par un
  pour qu'ils ne se chevauchent pas.
- `agent_requests.user_id` (migration 0041) : une demande sans conversation porte le
  compte pour qui agir ; `AgentRequests.principal` en fait un demandeur sans session,
  et chaque traitement s'abstient de ce qui n'a de sens que pour une session.
- Tests : `apps/server/test/mcp-global.test.ts` et le cas global de
  `agent-requests.test.ts`.
