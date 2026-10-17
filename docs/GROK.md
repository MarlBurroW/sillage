# Intégration Grok Build

Sillage lance un `grok agent --no-leader stdio` par conversation et lui parle en **ACP**
(Agent Client Protocol) : du JSON-RPC sur stdio, une ligne par message, comme l'éditeur
Zed. Grok Build double l'ACP standard d'extensions `_x.ai/…`, dans les deux sens. Tout
ce qui suit a été sondé sur **Grok Build 1.0.62** et lu dans ses sources publiques
(`xai-org/grok-build`, Apache-2.0, dont le dépôt public avait la 1.0.45 au moment de
l'intégration).

Le client ACP (`apps/server/src/agents/acp/client.ts`) est écrit à la main ; seuls les
types viennent du SDK officiel `@agentclientprotocol/sdk`. La `ClientSideConnection` du
SDK valide chaque message entrant avec son schéma zod, et rejetterait les variantes
propres à Grok au lieu de les laisser passer.

## Lancement et isolation

Le process reçoit un environnement qui coupe ce que Grok lit d'office ailleurs que dans
Sillage (`apps/server/src/agents/grok/launch.ts`) :

| Variable | Pourquoi |
|---|---|
| `GROK_{CLAUDE,CURSOR}_{RULES,SKILLS,MCPS,HOOKS,AGENTS,SESSIONS}_ENABLED=0` | Grok relit la configuration de Claude Code et de Cursor. Sans ça, SILLAGE.md et le serveur `sillage` arrivent en double. Surtout, Grok republie dans `_x.ai/mcp/servers_updated` l'environnement des serveurs MCP du `~/.claude.json`, jetons compris. |
| `GROK_TELEMETRY_ENABLED`, `GROK_TELEMETRY_TRACE_UPLOAD`, `GROK_ERROR_REPORTING` = `false`, `GROK_STORAGE_MODE=local` | Coupés par défaut, mais des réglages distants de xAI peuvent les allumer. L'envoi des traces de session (prompts, images) en fait partie. |
| `GROK_FOLDER_TRUST=0` | En ACP, un dossier non déclaré de confiance qui porte des consignes, des serveurs MCP ou des skills voit ces fichiers ignorés en silence, faute d'invite. |
| `GROK_DISABLE_AUTOUPDATER=1` | C'est Sillage qui choisit la version, comme pour les autres CLI. |

`--no-leader` donne un process à soi, sans le serveur partagé que `grok` lance pour ses
clients, et qui ignorerait `--plugin-dir`. `--disable-web-search` coupe les outils web ;
c'est une option de `grok` et non de `grok agent`, elle se place donc avant la
sous-commande.

## Ce qui se règle au lancement, et ce qui se règle à chaud

| Réglage Sillage | Chez Grok | À chaud |
|---|---|---|
| Modèle, effort | `_meta.modelId` et `_meta.reasoningEffort` de `session/new`, puis `session/set_config_option` (`model`, `reasoning_effort`) | oui |
| Demander (`default`) | `yoloMode` et `autoMode` faux | oui |
| Automatique (`auto`) | `autoMode` : un classifieur tranche | oui |
| Tout autoriser (`bypassPermissions`) | `yoloMode` | oui |
| Plan (`plan`) | `session/set_mode` `plan` ; Grok soumet le plan par `_x.ai/exit_plan_mode` et repasse en `default` | oui |
| Recherche web | `--disable-web-search` | relance |
| Bibliothèque de skills | `--plugin-dir` par racine ; `_x.ai/plugins/reload` après une écriture | relance pour l'interrupteur |
| Serveurs MCP du registre, serveur de Sillage | `mcpServers` de `session/new` (stdio, http, sse) | relance |
| SILLAGE.md, mémoire, transfert entre CLI | `_meta.rules` de `session/new`, ajouté au prompt système dans `<human_rules>` | à la création seulement |
| Consignes tenues dans SILLAGE.md | `_meta.agentProfile` avec `agentsMd: false` : les `AGENTS.md`/`CLAUDE.md` du dépôt sont sinon toujours lus | à la création et à la reprise |

Les permissions à chaud passent par la notification `_x.ai/yolo_mode_changed`
(`yolo_mode`, `auto_mode`), qui vise toutes les sessions du process : il n'y en a qu'une.

## Comportements relevés

- **Champ `systemPrompt` de l'ACP et option `--rules`** : ignorés par `grok agent`. Seul
  `_meta.rules` passe, et seulement à la création : une reprise garde le prompt système
  enregistré avec la session (`system_prompt.txt`).
- **Reprise** : `session/resume`, sans rejeu de l'historique. `session/load` rejouerait
  tout en `session/update`. `session/resume` refuse `additionalDirectories`, et
  `session/new` ne le lit pas : les fichiers hors du dossier de travail passent par une
  permission.
- **Notifications précoces** : les commandes en `/` et l'état des serveurs MCP arrivent
  avant la réponse à `session/new`. Le runner les garde et les rejoue.
- **Texte et réflexion** : en morceaux, sans identifiant de message.
- **Outils** : le nom fiable est `_meta["x.ai/tool"].name` (`read_file`, `search_replace`,
  `write`, `run_terminal_command`, `grep`, `list_dir`, `todo_write`, `spawn_subagent`…),
  ramené aux noms du journal (`Read`, `Edit`, `Write`, `Bash`…). Le `title` de l'ACP est
  une phrase qui change d'une mise à jour à l'autre. Les outils MCP ne sont pas exposés
  un par un : le modèle les cherche (`search_tool`) puis les appelle par `use_tool`, avec
  `serveur__outil` pour nom.
- **Sortie d'une commande** : cumulée dans `rawOutput.output`, en octets.
- **Éditions** : blocs `diff` (`path`, `oldText`, `newText`). Pour `search_replace`, ce
  sont les extraits remplacés, pas les fichiers entiers : le diff affiché est partiel.
- **Permission** : `session/request_permission` propose `allow-once`,
  `allow-edits-session`, `always-allow`, `reject-once`… Grok lit la réponse par son
  genre (`allow_once`, `allow_always`, `reject_once`). **Un refus clôt le tour entier**
  (`cancelled`, catégorie `PermissionRejected`), journalisé en `permission_denied`.
- **Questions** : requête `_x.ai/ask_user_question`, réponses rangées par intitulé de
  question. L'outil est actif par défaut.
- **Élicitations MCP** : requête `_x.ai/mcp/elicit` (formulaire ou URL), close par
  `_x.ai/mcp/elicit_complete`.
- **Infléchir** : `_x.ai/interject`, pris au prochain point sûr du tour. Un second
  `session/prompt` pendant un tour attend dans la file de Grok.
- **Interrompre** : `session/cancel`. Le `session/prompt` en cours répond `cancelled`.
- **Compaction** : `_x.ai/compact_conversation`, fin annoncée par `auto_compact_completed`
  (tailles avant et après) sous `_x.ai/session_notification`.
- **Fork** : `_x.ai/session/fork` avec `targetPromptIndex`, le rang du dernier prompt à
  garder (à partir de zéro). Chaque tour de Sillage en est un.
- **Consommation** : dans le `_meta.usage` de la réponse au `session/prompt`. `inputTokens`
  y compte le cache ; `costUsdTicks` vaut un dix-milliardième de dollar. La taille du
  contexte voyage dans le `_meta.totalTokens` de chaque `session/update`.
- **Images** : Grok annonce `image: false` mais lit les blocs image que son TUI lui
  envoie. Les fichiers mentionnés partent en liens `file://`, développés comme un `@chemin`.
- **Catalogue** : la réponse à `initialize` porte les modèles du compte connecté
  (`_meta.modelState`) et les commandes intégrées, sans ouvrir de session.

## Connexion

`grok login --device-auth` sur la machine qui fait tourner Sillage (abonnement
SuperGrok ou X Premium+), ou `XAI_API_KEY`. Les identifiants vont dans `~/.grok/auth.json`
(`GROK_HOME` pour un autre dossier).

## Hors périmètre de la première version

Comptes Grok multiples dans Sillage (un `GROK_HOME` par compte serait la voie), fil des
sous-agents (leurs `session/update` arrivent sous l'identifiant de leur propre session),
travaux de fond, quota de l'abonnement, import des sessions commencées dans le TUI.

## Vérifications

```sh
pnpm typecheck
pnpm test        # dont test/grok-runner.test.ts et test/grok-adapter.test.ts, sur un faux agent ACP
```

Pour un essai réel : un serveur Sillage jetable (`SILLAGE_DATA_DIR`, `SILLAGE_PORT`
libre, `SILLAGE_CONFIG` qui pointe `[agents.grok] binary` sur le binaire voulu), puis
une conversation Grok depuis l'interface.
