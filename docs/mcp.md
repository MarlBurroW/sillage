# Le serveur MCP de Sillage depuis un CLI local

Sillage monte dans chaque conversation un serveur MCP `sillage` qui rend au CLI ce que
la plateforme sait : l'historique, le board, les sessions en cours, la mémoire, et les
gestes qui passent par le daemon (lancer une session, créer une carte, planifier). Ce
même serveur, `apps/server/src/mcp/sillage-mcp.mjs`, se lance à la main depuis un CLI
hors Sillage : un Codex ou un Claude Code ouvert dans un terminal, sur la machine ou
depuis un poste qui s'y connecte en SSH.

Il parle en stdio et lit la base SQLite directement. Lancé à la main, il n'a ni port ni
jeton : il fait confiance à qui peut le lancer. Par HTTP, c'est le jeton d'API qui
authentifie (voir plus bas). Son environnement dit quelle portée il sert.

## Deux portées

| Variable | Mode conversation | Mode global |
|---|---|---|
| `SILLAGE_MCP_DB` | chemin de `sillage.db` | idem |
| `SILLAGE_MCP_PROJECT` | identifiant du projet servi | **absent** |
| `SILLAGE_MCP_USER` | — | nom du compte au nom duquel écrire ; facultatif si la base n'a qu'un compte |
| `SILLAGE_MCP_MEMORY` | dossier de mémoire du projet | racine de la mémoire (`memory/` à côté de la base par défaut) |
| `SILLAGE_MCP_PROJECTS` | — | liste blanche d'identifiants, séparés par des virgules ; posée par le pont HTTP d'après le jeton |
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
  décisions) : un client hors session n'a ni identité pour signer ni tour où recevoir ;
- à leur place, six outils agissent sur une session existante du compte comme
  l'utilisateur le ferait dans l'interface : `read_session` (état, activité, dernier
  message, sollicitation ouverte), `wait_for_session` (attend la fin du tour, 100 s au
  plus), `message_session` (un message ordinaire, remis à la fin du tour si elle
  travaille), `steer_session` (infléchit le tour en cours, sinon message ordinaire),
  `interrupt_session`, et `reply_session` (répond à une permission, une question, un
  plan ou une saisie, selon la forme que `read_session` décrit). Les quatre derniers
  passent par le daemon (`agent_requests`, sans migration).

Les gestes qui passent par le daemon restent soumis à ses gardes : au plus six
lancements par heure, comptés ensemble pour tout ce qui vient hors session, et le daemon
doit tourner, sinon la demande expire.

## Par HTTP, avec un jeton d'API

Pour un client qui n'est pas sur la machine et n'a pas de SSH, le même serveur se sert
par HTTP : `POST /api/v1/mcp`, transport « streamable HTTP » de MCP, derrière un jeton
d'API qui porte la portée **`mcp`** (réglages → API de Sillage). Le pont
(`apps/server/src/http/v1/mcp.ts`) ne réimplémente aucun outil : chaque session HTTP
est un process du serveur en mode global, au nom du compte du jeton et borné à la liste
de projets du jeton s'il en a une, et chaque message JSON-RPC lui est transmis.

- `initialize` ouvre la session et rend un en-tête `Mcp-Session-Id`, à présenter
  ensuite ; sans lui, ou après trente minutes sans requête, `404` : le client
  recommence par `initialize`. `DELETE` ferme la session.
- Toujours une réponse JSON, jamais un flux SSE ; `GET` répond `405`.
- Au plus quatre sessions par jeton ; au-delà, la plus ancienne est fermée.

Codex, depuis n'importe quel poste :

```toml
[mcp_servers.sillage]
url = "https://sillage.marlburrow.dev/api/v1/mcp"
bearer_token_env_var = "SILLAGE_TOKEN"   # exporté dans le shell qui lance codex
```

Claude Code :

```bash
claude mcp add --transport http sillage https://sillage.marlburrow.dev/api/v1/mcp \
  --header "Authorization: Bearer sillage_pat_…"
```

Le jeton est la frontière : il écrit consignes et mémoire, lance des sessions, crée des
cartes. Le restreindre à quelques projets limite ce qu'il atteint s'il fuit ; le révoquer
ferme ses sessions au prochain message.

## En stdio, sur la machine ou par SSH

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
- `http/v1/mcp.ts` : le pont HTTP, un process par session, portée `mcp` des jetons.
- `agent_requests.user_id` (migration 0041) : une demande sans conversation porte le
  compte pour qui agir ; `AgentRequests.principal` en fait un demandeur sans session,
  et chaque traitement s'abstient de ce qui n'a de sens que pour une session.
- Tests : `apps/server/test/mcp-global.test.ts`, `mcp-http.test.ts` et le cas global de
  `agent-requests.test.ts`.

### Modifier les cartes du projet

Toute session peut modifier une carte de son projet, même sans y être rattachée :
`update_card` prend son `number` et le nouveau `title` ou la nouvelle `description`.
La description remplace le texte entier ; il faut lire la carte avant de la modifier.
`add_card_note` et `update_issue` acceptent aussi `number` ; sans numéro, ils visent
la carte rattachée à la conversation. En mode global, leur paramètre `card` est conservé.
Les modifications des cartes liées à GitHub sont synchronisées sur leurs issues.

### Relier les tickets

`link_cards` ajoute une relation explicite, `unlink_cards` la retire. Tous deux
prennent `number` (ticket de départ), `target` (ticket cible) et `kind` :

| `kind` | Depuis le ticket de départ | Sens inverse |
| --- | --- | --- |
| `blocks` | Bloque | `blocked_by` : est bloqué par |
| `related` | Est lié à | Identique |
| `duplicates` | Est un doublon de | `duplicated_by` : a pour doublon |
| `parent` | Contient le sous-ticket | `child` : est un sous-ticket de |
| `replaces` | Remplace | `replaced_by` : est remplacé par |

Le sens inverse est aussi accepté à la création et à la suppression. Par exemple,
`link_cards(number: 12, target: 4, kind: "child")` fait de #12 un sous-ticket de #4.
`read_card` affiche les relations avec le titre et la colonne des tickets reliés.
Toute session du projet peut les gérer ; en mode global, préciser aussi `project`.

Les deux tickets doivent appartenir au même projet. Un ticket ne se relie pas à
lui-même, les doublons de liens sont ignorés, les chaînes circulaires sont refusées
et un sous-ticket a au plus un parent. Les relations restent locales à Sillage :
elles ne sont pas publiées sur GitHub, ne ferment aucun doublon et ne déplacent
aucun ticket. Les mentions `#12` dans le texte restent de simples références.
