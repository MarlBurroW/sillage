# Sillage

Plateforme de développement agentique self-hosted et multi-CLI.

Le sillage, c'est la trace qu'un navire laisse derrière lui. Ici, c'est le journal
ordonné et rejouable de tout ce que font tes agents, et c'est aussi la propriété
technique centrale du produit : rien de ce qui se passe n'est perdu si le réseau tombe.

---

## 0. Décisions verrouillées

| Sujet | Décision |
|---|---|
| Nom | Sillage |
| Modèle multi-utilisateur | Cercle de confiance : comptes séparés, ressources partageables, pas d'isolation système |
| Credentials CLI | Ceux de l'hôte (`~/.claude`, `~/.codex`), partagés par tous les utilisateurs |
| Backend | Node 22 + TypeScript + Fastify |
| Frontend | React 19 + Vite + Tailwind, PWA installable |
| Base | SQLite (WAL) via Drizzle ORM |
| Déploiement | Unité systemd sur la machine hôte (installeur fourni) ; image Docker en option |
| CLI cibles v1 | Claude Code 2.1.x, Codex 0.142.x |

### Docker : optionnel, pas isolant

Décision initiale : pas de Docker, parce que les agents ont besoin d'un accès direct au
système de fichiers de l'hôte (les workspaces sont des dossiers réels), aux credentials
de l'hôte, à `git` et aux clés SSH. Tout cela reste vrai : l'image Docker publiée depuis
la 0.1 n'apporte aucune isolation, elle monte credentials et projets depuis l'hôte. Elle
existe parce qu'elle simplifie l'installation (CLIs agents préinstallés, pas de Node à
gérer), pas pour cloisonner. Le déploiement de référence reste le daemon systemd sous
ton compte utilisateur, désormais posé par `install.sh` avec un layout versionné
(`app/releases/vX.Y.Z` + lien `current`) qui permet la mise à jour depuis l'UI.

### Pourquoi pas Rust

Les deux protocoles à consommer sont livrés typés en TypeScript et changent à chaque
release de CLI :

- Claude Code : `@anthropic-ai/claude-agent-sdk`, qui encapsule le protocole de contrôle
  bidirectionnel (frames `control_request` / `control_response` sur stdin/stdout). Ce
  protocole n'est pas documenté publiquement et c'est le seul moyen d'obtenir une vraie
  demande de permission interactive.
- Codex : `codex app-server generate-ts -o <dir>` génère les bindings depuis le binaire
  installé.

Réécrire et resuivre les deux à la main en Rust coûterait environ 50 Mo de RSS gagnés,
face à 450 Mo consommés par une seule session `claude`. Le mauvais côté du compromis.

### Contrainte machine à respecter

Ryzen 3 3300U, 4 cœurs, 15,6 Go de RAM dont environ 10 déjà occupés en permanence.
Règles qui en découlent, non négociables :

1. Aucun transcript en mémoire. Les événements sont écrits en base au fil de l'eau,
   le client les relit depuis la base.
2. `--max-old-space-size=256` sur le daemon.
3. Aucun hook CLI qui forke un process par événement.
4. Le frontend est buildé et servi en statique par Fastify, pas de serveur Node front.
5. Un plafond configurable de sessions agent simultanées (défaut : 3), avec file d'attente
   au-delà. Une session Claude coûte 400 à 500 Mo, c'est le seul poste qui compte.

---

## 1. Non-objectifs

Explicitement hors périmètre, pour éviter la dérive :

- Pas d'exécution d'agents dans le cloud ni sur des machines distantes. Sillage pilote
  les CLI installés sur son propre hôte.
- Pas de sandboxing des agents. On s'en remet aux modes de permission des CLI.
- Pas d'éditeur de code intégré. Sillage est un client de conversation, pas un IDE.
- Pas de facturation, quotas ou reporting de coûts par utilisateur en v1 (le coût total
  par conversation est affiché, sans agrégation).
- Pas de collaboration temps réel à plusieurs sur une même conversation en v1. Deux
  utilisateurs peuvent regarder, un seul est propriétaire et envoie les messages.

---

## 2. Invariants d'architecture

Ce sont les quatre règles qui répondent directement aux défauts d'Omnigent.

### I1. Le process agent est découplé du transport

Un WebSocket qui tombe ne doit jamais interrompre un agent, ni faire perdre un octet de
sa sortie. Le daemon supervise les process agent ; les clients ne font que s'abonner à un
journal. Fermer l'onglet, verrouiller son téléphone, passer du wifi à la 4G : aucun effet
sur l'exécution.

### I2. Le journal d'événements est la source de vérité

Chaque conversation possède une séquence d'événements strictement croissante
(`seq`, entier, sans trou). Tout ce que produit un agent y est appendé avant d'être
diffusé. Le client stocke le dernier `seq` reçu ; à la reconnexion il envoie ce curseur
et reçoit le delta. L'UI n'a donc jamais besoin de deviner ce qu'elle a manqué.

Corollaire : le rendu du chat est une fonction pure du journal. Rejouer le journal depuis
zéro doit produire exactement l'écran courant. Toute donnée d'affichage qui ne vient pas
du journal est un bug.

### I3. Un schéma d'événements unique, indépendant du CLI

L'UI ne sait jamais si elle parle à Claude ou à Codex. Chaque CLI a un adaptateur qui
traduit son flux natif vers le schéma commun (section 5). Ajouter Gemini CLI, Amp ou
autre revient à écrire un adaptateur, sans toucher au frontend ni à la base.

Le payload natif brut de chaque événement est conservé dans une colonne à part. Un
renderer spécialisé (section 12.5) peut s'en servir plus tard sans qu'on ait à
re-normaliser quoi que ce soit.

### I4. Un projet n'appartient à aucun CLI

Le CLI est une propriété de la conversation (`conversations.agent`), jamais du projet.
Un même projet porte simultanément des conversations Claude et des conversations Codex,
qui partagent son workspace et ses worktrees. Rien dans l'UI ne doit laisser croire
l'inverse : pas de choix de CLI à la création d'un projet, pas de filtrage des projets
par CLI.

Corollaire : quand un troisième CLI arrive, aucun projet existant n'a besoin d'être
modifié ou recréé. Le sélecteur de CLI d'une nouvelle conversation se pré-remplit avec
celui de la dernière conversation du projet, valeur dérivée des données plutôt que
réglage à maintenir.

### I5. Idempotence des envois

Le client génère un `client_message_id` (UUID) pour chaque message envoyé. Un renvoi
après timeout réseau avec le même identifiant est ignoré côté serveur. Sans ça, sur
mobile, un message part deux fois dès que le réseau hésite.

---

## 3. Topologie des process

```
                    navigateur (desktop / PWA mobile)
                              │  HTTPS + WSS
                              ▼
      ┌──────────────────────────────────────────────┐
      │  sillage-daemon  (Node 22, un seul process)  │
      │                                              │
      │   Fastify  ──  routes REST + WS + statique   │
      │   SessionManager  ── supervise les runners   │
      │   EventLog  ── append SQLite + fan-out       │
      │   PtyManager  ── terminaux node-pty          │
      └───────┬───────────────────────┬──────────────┘
              │ child_process         │ child_process
      ┌───────▼────────┐      ┌───────▼─────────┐
      │ claude         │      │ codex           │
      │ --input-format │      │ app-server      │
      │ stream-json    │      │ (JSON-RPC)      │
      └────────────────┘      └─────────────────┘
```

Un seul process Node. Les runners sont des enfants directs, pas des workers Node
supplémentaires (chaque worker coûterait 40 Mo pour rien).

**Cycle de vie d'un runner.** Un runner est démarré au premier message d'une conversation
et reste vivant tant que la conversation est « active ». Il est arrêté :

- sur demande explicite (bouton Stop),
- après `idle_timeout` sans message (défaut : 30 minutes), pour libérer les 450 Mo,
- à l'arrêt du daemon.

Quand un runner arrêté reçoit un nouveau message, il est relancé en mode reprise
(`--resume <session_id>` pour Claude, `thread/resume` pour Codex). L'utilisateur ne voit
pas la différence : la conversation continue. C'est ce qui rend le plafond de sessions
simultanées acceptable.

**Reprise après crash du daemon.** Au démarrage, le daemon marque toutes les conversations
en état `running` comme `interrupted` et appende un événement `error` explicite dans leur
journal. Aucune conversation ne reste bloquée dans un état « en cours » mensonger.

---

## 4. Modèle de données

SQLite en mode WAL, `synchronous = NORMAL`, `busy_timeout = 5000`. Un seul fichier
`sillage.db` dans le répertoire de données.

```sql
-- Utilisateurs et sessions d'authentification

CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- uuid
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,             -- argon2id
  display_name  TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash  TEXT PRIMARY KEY,            -- sha256 du token de cookie
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);

-- Projets

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace_path TEXT NOT NULL,            -- chemin absolu, vérifié à la création
  owner_id      TEXT NOT NULL REFERENCES users(id),
  visibility    TEXT NOT NULL,             -- 'private' | 'shared'
  color         TEXT,                      -- accent d'UI, optionnel
  default_config TEXT,                     -- JSON : préréglages de la barre d'options
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL
);

-- Worktrees git rattachés à un projet

CREATE TABLE worktrees (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,               -- nom de branche
  path        TEXT NOT NULL,               -- chemin absolu du worktree
  base_ref    TEXT NOT NULL,               -- ref de départ
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,
  UNIQUE(project_id, name)
);

-- Conversations

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id     TEXT REFERENCES worktrees(id),   -- NULL = racine du projet
  user_id         TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  agent           TEXT NOT NULL,           -- 'claude' | 'codex'
  agent_session_id TEXT,                   -- id natif, pour --resume / thread/resume
  config          TEXT NOT NULL,           -- JSON AgentConfig, voir section 6/7
  status          TEXT NOT NULL,           -- 'idle'|'running'|'awaiting_input'|'interrupted'|'error'
  last_seq        INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_conv_project ON conversations(project_id, updated_at DESC);

-- Le journal. Table la plus sollicitée.

CREATE TABLE events (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  type            TEXT NOT NULL,           -- discriminant, voir section 5
  payload         TEXT NOT NULL,           -- JSON normalisé
  raw             TEXT,                    -- JSON natif du CLI, pour les renderers futurs
  PRIMARY KEY (conversation_id, seq)
) WITHOUT ROWID;

-- Index de recherche. Table dérivée du journal (invariant I2), reconstructible par
-- rejeu : elle ne porte aucune information que `events` n'aurait pas.
CREATE VIRTUAL TABLE search_messages USING fts5(
  text,
  conversation_id UNINDEXED,
  seq UNINDEXED,
  role UNINDEXED,
  ts UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Demandes de permission en attente

CREATE TABLE permission_requests (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,        -- l'événement permission.requested associé
  tool_name       TEXT NOT NULL,
  input           TEXT NOT NULL,           -- JSON
  status          TEXT NOT NULL,           -- 'pending'|'allowed'|'denied'|'expired'
  decision_scope  TEXT,                    -- 'once'|'session'|'always'
  decided_by      TEXT REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);

CREATE INDEX idx_perm_pending ON permission_requests(conversation_id, status);

-- Pièces jointes

CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,           -- sous le répertoire de données
  created_at      INTEGER NOT NULL
);

-- Préférences par utilisateur (thème, densité, etc.)

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    TEXT NOT NULL                    -- JSON
);
```

**Rétention.** `events` grossit vite (les deltas de texte sont nombreux). Deux mesures :

1. Les événements `message.delta` et `thinking.delta` sont compactés dans l'événement
   `message.completed` correspondant dès que le message est terminé, puis supprimés. Le
   journal historique ne contient donc que des messages entiers ; seule la conversation
   en cours porte des deltas.
2. Une tâche de maintenance quotidienne supprime les événements des conversations
   archivées depuis plus de 90 jours (durée configurable), et exécute un `VACUUM`
   hebdomadaire.

---

## 5. Protocole d'événements normalisé

Défini une fois en Zod dans `packages/protocol`, importé par le serveur et par le front.
C'est le contrat de I3.

```ts
type SillageEvent =
  // Cycle de vie
  | { type: 'session.started';   agent: AgentKind; agentSessionId: string;
                                 model: string; cwd: string; tools: string[] }
  | { type: 'session.ended';     reason: 'completed' | 'interrupted' | 'error' }
  | { type: 'turn.started' }
  | { type: 'turn.completed';    stopReason: string; costUsd: number;
                                 inputTokens: number; outputTokens: number }

  // Contenu
  | { type: 'message.started';   messageId: string; role: 'user' | 'assistant' }
  | { type: 'message.delta';     messageId: string; text: string }
  | { type: 'message.completed'; messageId: string; role: 'user' | 'assistant';
                                 blocks: ContentBlock[] }
  | { type: 'thinking.delta';    messageId: string; text: string }

  // Outils
  | { type: 'tool.started';      toolCallId: string; name: string;
                                 input: unknown; parentToolCallId?: string }
  | { type: 'tool.output_delta'; toolCallId: string; chunk: string }
  | { type: 'tool.completed';    toolCallId: string; output: unknown;
                                 isError: boolean; durationMs: number }

  // Interaction requise
  | { type: 'permission.requested'; requestId: string; toolName: string;
                                    input: unknown; suggestions: PermissionOption[];
                                    // Libellés rédigés par le CLI lui-même
                                    title: string | null; description: string | null;
                                    displayName: string | null }
  | { type: 'permission.resolved';  requestId: string;
                                    decision: 'allowed' | 'denied' | 'expired';
                                    scope: 'once' | 'session' | 'always';
                                    decidedBy: string | null }
  | { type: 'question.requested';   requestId: string; questions: AgentQuestion[] }
  | { type: 'question.resolved';    requestId: string;
                                    status: 'answered' | 'cancelled' | 'expired';
                                    answers: Record<string, string[]>;
                                    decidedBy: string | null }
  | { type: 'plan.review_requested'; requestId: string; plan: string }
  | { type: 'plan.review_resolved';  requestId: string;
                                     decision: 'approved' | 'rejected' | 'expired';
                                     followUpMode: ClaudePermissionMode | null;
                                     decidedBy: string | null }

  // Métadonnées
  | { type: 'plan.updated';      items: { text: string; status: PlanStatus }[] }
  | { type: 'usage.updated';     costUsd: number; inputTokens: number;
                                 outputTokens: number;
                                 rateLimit?: { type: string; resetsAt: number } }
  | { type: 'diff.updated';      files: { path: string; added: number;
                                          removed: number }[] }
  | { type: 'error';             code: string; message: string;
                                 recoverable: boolean }
```

`ContentBlock` couvre `text`, `thinking`, `image`, `file`, `tool_use`, `tool_result`. Le
champ `parentToolCallId` désigne l'appel qui a lancé le sous-agent auteur de
l'événement : c'est lui qui sépare le fil principal des fils de sous-agents.

### 5.1 Sollicitations de l'utilisateur

Trois formes d'interaction bloquent un tour, et elles ne se confondent pas :

| Forme | Claude Code | Codex |
| --- | --- | --- |
| Permission d'outil | rappel `canUseTool` | `item/*/requestApproval` |
| Question à choix | outil `AskUserQuestion` | `item/tool/requestUserInput` |
| Validation de plan | outil `ExitPlanMode` | aucun équivalent |
| Élicitation MCP | rappel `onElicitation` | `mcpServer/elicitation/request` |

Les deux outils de Claude passent par le même rappel `canUseTool` que les permissions,
mais la réponse attendue n'est pas « autorisé » ou « refusé » : pour `AskUserQuestion`
elle voyage dans `updatedInput.answers`, sous une clé qui est l'intitulé de la question.
Ce comportement n'est pas documenté dans les types du SDK ; il a été relevé en observant
le CLI installé, et la forme de l'entrée est ancrée par une assertion de compilation
(`apps/server/src/agents/claude/prompts.ts`).

`AgentQuestion` normalise les deux protocoles : `id`, `header`, `question`,
`multiSelect`, `allowOther`, `secret`, `options[]`. Ce que le protocole ne transporte pas
n'est pas inventé : Codex n'a pas de choix multiple ni d'aperçu d'option, ces champs y
valent donc `false` et `null`.

Valider un plan implique de choisir comment la suite s'exécute (`followUpMode`) : sortir
du mode plan sans changer de mode ferait retomber l'agent dans celui qui l'a fait
planifier, et il replanifierait au lieu d'agir.

**Élicitations MCP.** Un serveur MCP peut réclamer une saisie à l'utilisateur
(`elicitation/create`). Ce n'est ni l'agent ni le CLI qui demande, mais un tiers branché
sur la session : le nom du serveur est donc affiché, et les trois réponses du protocole
(`accept`, `decline`, `cancel`) sont proposées.

Contrairement aux autres formes, le contrat est ici **identique des deux côtés**, parce
que ni Claude ni Codex ne l'a inventé : c'est MCP. Le `requestedSchema` est un JSON
Schema plat limité à des primitives, que Claude transmet brut et que Codex type. Un seul
analyseur (`packages/protocol/src/elicitation.ts`) le normalise donc en cinq formes de
champ (texte, nombre, booléen, choix, choix multiple), et il n'appartient à aucun
adaptateur. La réponse est la même des deux côtés : une action, plus un contenu quand
elle vaut `accept`.

L'analyseur est tolérant par construction : un champ dont le type n'est pas reconnu est
ignoré plutôt que rendu au hasard, et un schéma illisible laisse le message et les
boutons d'action. Un champ mal deviné produirait une réponse fausse que le serveur MCP
accepterait sans le savoir.

Les bindings Codex servent de source typée pour trois assertions de compilation : les
actions doivent correspondre exactement, et chaque variante de champ doit trouver preneur
dans l'une des formes reconnues. Vérifié en retirant une variante : le typecheck échoue.
Une réserve à connaître, relevée sur le CLI installé : les serveurs MCP **en processus**
du SDK (`createSdkMcpServer`) ne peuvent pas éliciter, le transport répond
`-32601 Method not found`. Seuls les serveurs stdio le peuvent, ce qui est la forme
réelle d'un serveur MCP.

Une demande sans réponse ne doit jamais rester ouverte. Deux garde-fous : le runner clôt
ses demandes en attente quand il s'arrête, et le gestionnaire de sessions relit le journal
au démarrage pour clore celles qu'un daemon tué net a laissées derrière lui
(`EventLog.openPrompts`).

**Règle de traduction.** Un adaptateur qui rencontre un événement natif qu'il ne sait pas
traduire ne le laisse pas tomber en silence : il l'écrit avec `type: 'error'` en mode non
bloquant seulement s'il est significatif, sinon il l'ignore explicitement via une liste
d'exclusion nommée dans le code. Pas de `default:` muet.

---

## 6. Adaptateur Claude Code

### Lancement

Via `@anthropic-ai/claude-agent-sdk` en mode streaming input, ce qui donne le callback
`canUseTool` et la possibilité d'envoyer des messages successifs sans relancer le process.

Ce que ça implique, vérifié empiriquement sur la version 2.1.220 : en `--print` sans
stdin actif, `--permission-mode manual` **refuse** l'outil et renvoie un `tool_result`
en erreur ("Claude requested permissions to write to X, but you haven't granted it yet"),
sans jamais demander quoi que ce soit. Le canal bidirectionnel n'est donc pas une
optimisation, c'est la condition pour avoir un bouton Autoriser.

Options passées :

| Réglage UI | Flag / option SDK | Valeurs |
|---|---|---|
| Modèle | `--model` | `opus`, `sonnet`, `haiku`, `fable`, ou id complet. Liste récupérée dynamiquement, avec repli sur une liste en dur |
| Effort | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| Mode de permission | `--permission-mode` | `manual`, `auto`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| Répertoire de travail | `cwd` | chemin du worktree, ou du projet |
| Dossiers additionnels | `--add-dir` | multi |
| Reprise | `--resume <uuid>` | via `agent_session_id` |
| Id imposé | `--session-id <uuid>` | on impose le nôtre à la création |
| Sortie | `--output-format stream-json --include-partial-messages` | fixe |
| Entrée | `--input-format stream-json` | fixe |

`bypassPermissions` est marqué en rouge dans l'UI avec une confirmation explicite, et
n'est pas mémorisable comme défaut de projet.

### Traduction des événements

| Natif | Normalisé |
|---|---|
| `system/init` | `session.started` (on y lit `session_id`, `tools`, `cwd`, `model`) |
| `stream_event` avec `content_block_delta` type `text_delta` | `message.delta` |
| `stream_event` avec `thinking_delta` | `thinking.delta` |
| `assistant` avec bloc `tool_use` | `tool.started` |
| `user` avec bloc `tool_result` | `tool.completed` |
| `assistant` final | `message.completed` |
| appel de `canUseTool` | `permission.requested`, la promesse est résolue par la réponse HTTP de l'UI |
| `result` | `turn.completed` + `usage.updated` |
| `rate_limit_event` | `usage.updated` (champ `rateLimit`) |
| `system/thinking_tokens` | ignoré (liste d'exclusion : bruit de progression) |

Les sous-agents (`parent_tool_use_id` non nul) sont conservés et portent cet identifiant
jusqu'au journal. L'option `forwardSubagentText` est activée : sans elle le SDK ne
transmet que leurs appels d'outils, de quoi faire battre un compteur mais pas de quoi
rendre leur fil, ni raisonnement ni messages intermédiaires.

Le transcript relu sur disque les range à part, dans
`<sessionId>/subagents/agent-<agentId>.jsonl`, sans y répéter l'appel d'origine : le lien
passe par l'`agentId` que le transcript principal joint au résultat de l'appel `Task`.
L'import relit ces fichiers et fusionne leurs événements par horodatage. Ils ne portent
ni frontière de tour ni compaction : un sous-agent travaille *dans* le tour de son
parent, il n'en ouvre pas. À la resynchronisation, le découpage au point commun ne leur
convient pas, leur chronologie étant la leur : c'est entrée par entrée, sur l'`uuid`,
qu'on écarte ce que le journal porte déjà.

---

## 7. Adaptateur Codex

### Lancement

Via `codex app-server` (JSON-RPC sur stdio). Les types sont générés depuis le binaire
installé et commités :

```
codex app-server generate-ts -o packages/protocol/src/codex/
```

Un script `pnpm codex:types` régénère et un test de CI échoue si le fichier généré
diffère du commité, ce qui signale une montée de version de Codex à traiter.

### Méthodes utilisées

Relevées dans le schéma de la version 0.142.2 :

**Client vers serveur :** `thread/start`, `thread/resume`, `thread/list`, `thread/read`,
`thread/fork`, `thread/archive`, `thread/name/set`, `turn/start`, `turn/interrupt`,
`turn/steer`, `thread/compact/start`, `model/list`, `config/read`, et
`collaborationMode/list` (voir ci-dessous).

### Mode de collaboration

Codex a l'équivalent du mode Plan de Claude, et il ne se limite pas à une consigne : c'est
le **routeur d'outils du CLI** qui décide, en fonction du mode, de ce que le modèle peut
appeler. En `default`, `request_user_input` est refusé, si bien qu'une demande de choix
retombe en liste écrite dans la réponse. C'est ce qui expliquait qu'un agent Codex réponde
« je dois être en mode plan pour ça ».

Le chemin a été trouvé en sondant le binaire installé, aucune documentation ne le décrivant :

- `initialize` doit déclarer la capacité **`experimentalApi`**. Sans elle, `turn/start`
  répond `collaborationMode requires experimentalApi capability` ;
- `collaborationMode/list` renvoie les préréglages (`Plan`, `Default`), avec leur nom
  d'affichage. La liste vient donc du CLI, elle n'est pas écrite dans Sillage ;
- `turn/start.collaborationMode` porte le mode, tour par tour, comme le modèle et le
  sandbox. `thread/settings/updated` le confirme en retour.

Ce qui a été essayé et **ne marche pas** : `config.collaboration_mode` à
`thread/start`, `developerInstructions` avec le prompt de mode Plan, et l'injection d'un
message développeur par `thread/inject_items`. Dans les trois cas le routeur reste en
`Default mode`.

`collaborationMode/list` et le champ de `turn/start` ne sont pas exportés par
`generate-ts` : ils passent par un `callExperimental` nommé pour rester visible, et le
type du champ est ajouté par intersection à partir de `CollaborationMode`, qui, lui, est
généré. Rien n'est retranscrit à la main. Une version de Codex qui ne connaîtrait pas
`collaborationMode/list` fait simplement disparaître le sélecteur, plutôt que d'offrir un
réglage sans effet.

Vérifié de bout en bout sur les deux modes, à travers Sillage : en `plan`, la même demande
produit un `question.requested` normalisé et l'interface affiche des boutons de choix ; en
`default`, elle produit une liste en texte. La réponse renvoyée au CLI clôt bien la
demande (`question.resolved`), et le tour se termine ensuite.

**Serveur vers client (notifications) :** `thread/started`, `thread/status/changed`,
`item/started`, `item/completed`, `item/agentMessage/delta`,
`item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`,
`item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`,
`item/mcpToolCall/progress`, `turn/started`, `turn/completed`, `turn/diff/updated`,
`turn/plan/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated`.

**Serveur vers client (requêtes, à répondre) :** `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval`,
`item/tool/requestUserInput`.

Ces trois requêtes d'approbation se mappent exactement sur `permission.requested`, comme
`canUseTool` côté Claude. C'est ce qui rend l'UI de permission unique pour les deux CLI.

### Réglages exposés

| Réglage UI | Paramètre Codex | Valeurs |
|---|---|---|
| Modèle | `model` | via `model/list` |
| Effort de raisonnement | `-c model_reasoning_effort` | `minimal`, `low`, `medium`, `high` |
| Approbation | `askForApproval` | `untrusted`, `on-request`, `never` |
| Sandbox | `sandbox` | `read-only`, `workspace-write`, `danger-full-access` |
| Recherche web | `--search` | booléen |
| Répertoire | `cwd` | worktree ou projet |
| Profil | `-p/--profile` | liste depuis `$CODEX_HOME` |

L'UI présente Claude et Codex avec le même formulaire, les champs non pertinents étant
simplement absents. Elle ne prétend pas que les deux CLI ont les mêmes concepts : le mode
de permission Claude et le couple approbation/sandbox de Codex sont affichés tels quels,
avec leur vocabulaire natif.

---

## 8. API

### REST

Toutes les routes sont sous `/api`, authentifiées par cookie de session
(`HttpOnly`, `SameSite=Lax`, `Secure` si HTTPS).

```
POST   /api/auth/login              { username, password } -> Set-Cookie
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/projects
POST   /api/projects                { name, workspacePath, visibility }
POST   /api/projects/order          { ids[] }   ordre manuel de la sidebar
PATCH  /api/projects/:id
DELETE /api/projects/:id
GET    /api/projects/:id/branches           git branch --list
GET    /api/projects/:id/files              ?q=&worktreeId=  autocomplétion des mentions
GET    /api/projects/:id/worktrees
POST   /api/projects/:id/worktrees          { name, baseRef }
DELETE /api/worktrees/:id                   { force?: boolean }

GET    /api/conversations                   toutes les conversations visibles
GET    /api/projects/:id/conversations      ?archived=
POST   /api/projects/:id/conversations      { agent, config, worktreeId?, firstMessage? }
POST   /api/projects/:id/conversations/order { ids[] }
GET    /api/conversations/:id
PATCH  /api/conversations/:id               { title?, config?, pinned?, archived? }
DELETE /api/conversations/:id
GET    /api/conversations/:id/events        ?after=<seq>&limit=500

POST   /api/conversations/:id/messages      { clientMessageId, text,
                                              attachmentIds[], mentions[] }
POST   /api/conversations/:id/fork           { throughSeq, title? } -> branche
POST   /api/conversations/:id/steer          infléchit le tour en cours (Codex)
POST   /api/conversations/:id/interrupt
POST   /api/conversations/:id/compact
POST   /api/conversations/:id/permissions/:requestId  { decision, scope }
POST   /api/conversations/:id/questions/:requestId    { status, answers }
POST   /api/conversations/:id/elicitations/:requestId { action, content }
DELETE /api/conversations/:id/queue/:queueId          retire un message en attente
POST   /api/conversations/:id/plans/:requestId        { decision, followUpMode }

POST   /api/attachments                     multipart -> { id, filename, ... }
GET    /api/attachments/:id

GET    /api/push                            clé publique VAPID + état d'abonnement
POST   /api/push/subscribe                  { endpoint, keys }
POST   /api/push/unsubscribe                { endpoint }

GET    /api/search?q=                       messages contenant la requête, visibilité appliquée

GET    /api/conversations/:id/tree?path=    un niveau du workspace, avec l'état git par entrée
GET    /api/conversations/:id/edits/:toolCallId?path=   ce qu'un appel a fait d'un fichier
POST   /api/conversations/:id/entries        { parent, name, kind } -> crée un fichier ou un dossier
POST   /api/conversations/:id/entries/move   { from, to } -> renomme ou déplace
DELETE /api/conversations/:id/entries        { path }
GET    /api/conversations/:id/file?path=    contenu texte d'un fichier, avec son empreinte disque
GET    /api/conversations/:id/file/raw       contenu brut, images seulement
PUT    /api/conversations/:id/file           { path, content, fingerprint } -> 409 si le disque a bougé

GET    /api/agents                          capacités et modèles disponibles par CLI
GET    /api/health                          état du daemon, sessions actives, RSS

WS     /api/ws                              journal et statuts, multiplexé
GET    /api/conversations/:id/terminals     terminaux ouverts
POST   /api/conversations/:id/terminals     en ouvre un dans le cwd de la conversation
PATCH  /api/conversations/:id/terminals/:tid  { title }
DELETE /api/conversations/:id/terminals/:tid

WS     /api/conversations/:id/terminal?terminalId=   pty, socket dédiée (section 10)
```

`GET /api/conversations/:id/events` est la route de rattrapage. Elle est paginée et
utilisée aussi bien au chargement initial (depuis `after=0`) qu'après une longue coupure.

### WebSocket

Une seule connexion par onglet, sur `/api/ws`. Multiplexée : un client peut suivre
plusieurs conversations.

`status` fait exception à l'abonnement : il part pour toute conversation lisible par le
compte, abonnée ou non. La sidebar affiche des lignes qu'elle n'a pas ouvertes et n'a
pas de journal à replier pour en déduire l'état ; l'abonner au flux de chacune ferait
rejouer autant de journaux pour une pastille. Le droit de lecture est revérifié à chaque
poussée, et la reprise après coupure relit la liste plutôt que d'attendre la prochaine
transition.

Client vers serveur :

```ts
{ t: 'subscribe',   conversationId: string, afterSeq: number }
{ t: 'unsubscribe', conversationId: string }
{ t: 'ping' }
```

Serveur vers client :

```ts
{ t: 'event',   conversationId: string, seq: number, ts: number,
                type: string, payload: unknown }
{ t: 'status',  conversationId: string, status: ConversationStatus }
{ t: 'catchup', conversationId: string, fromSeq: number, toSeq: number }
{ t: 'pong' }
```

**Séquence de reconnexion.** Le client garde en mémoire (et en IndexedDB) le dernier `seq`
par conversation. À la reconnexion il renvoie `subscribe` avec ce curseur. Si le retard
dépasse 500 événements, le serveur répond `catchup` et le client bascule sur la route REST
paginée plutôt que de recevoir un déluge sur le socket.

Heartbeat applicatif toutes les 25 secondes (`ping`/`pong`), reconnexion automatique avec
backoff exponentiel plafonné à 15 secondes, et reconnexion immédiate sur les événements
`online` et `visibilitychange` du navigateur. C'est ce dernier point qui fait la
différence sur mobile, où le socket est tué dès que l'écran s'éteint.

---

## 9. Worktrees

À la création d'une conversation, trois choix :

1. **Racine du projet.** L'agent travaille directement dans `workspace_path`.
2. **Worktree existant.** Liste des worktrees connus du projet, avec leur branche.
3. **Nouveau worktree.** Nom de branche et ref de base. Sillage exécute
   `git worktree add <path> -b <name> <baseRef>` avec `<path>` sous
   `<données>/worktrees/<project_id>/<name>`.

On ne délègue pas à `claude --worktree`, parce que Codex ne l'a pas et que Sillage doit
savoir où sont les worktrees pour les lister et les nettoyer. La gestion est donc côté
Sillage, identique pour les deux CLI.

La suppression d'un worktree affiche d'abord le résultat de `git status --porcelain` dans
ce worktree. S'il y a des modifications non commitées, la suppression exige une
confirmation explicite. Les conversations rattachées à un worktree supprimé passent en
lecture seule au lieu d'être effacées.

---

## 10. Mode terminal

Un terminal réel, pas une émulation de commandes. `node-pty` côté serveur, `xterm.js`
côté client avec l'addon `fit`.

**Ce que ce terminal n'est pas.** Il n'affiche pas l'interface du CLI. Le process agent
est lancé par le SDK en mode headless (`--input-format stream-json --output-format
stream-json`, stdio en tuyaux) : il ne dessine rien, il n'y a aucune image à mirroir. Un
« switch CLI / Web » supposerait de lancer le vrai TUI dans un pty et d'en tirer les
données structurées par des hooks, c'est-à-dire de remplacer les invariants I2 et I3 par
un buffer d'écran. Écarté.

**État.** Le pty, sa socket et le composant `xterm` sont écrits et vérifiés, mais la vue
n'est pas montée : la bascule sous la barre de saisie laissait croire à ce switch. Le
terminal réapparaîtra dans le panneau latéral d'outils, avec l'explorateur de fichiers
colorés par état git, l'édition à onglets et l'historique des modifications de l'agent.

- Le PTY démarre dans le répertoire de travail de la conversation (worktree compris).
- Un PTY survit à la déconnexion du client (même invariant I1), avec un tampon des
  128 derniers Ko rejoué à la reconnexion : fermer un onglet n'interrompt pas une
  commande en cours.
- Fermeture automatique après `limits.ptyIdleTimeoutMin` sans activité (60 min par défaut).
- Socket dédiée (`/api/conversations/:id/terminal`), distincte de celle du journal : la
  sortie d'un shell n'est pas du contenu de conversation, elle n'est jamais persistée, et
  son débit ferait passer les événements du fil derrière des kilo-octets de sortie de
  compilation.
- Sur mobile, une barre de touches auxiliaires : `Échap`, `Tab`, `Ctrl+C`, `Ctrl+D` et
  les flèches. Sans ça, impossible de compléter un chemin ou d'interrompre une commande.

### 10.1 Copier-coller

C'est le point qui rate sur la plupart des terminaux web, et il rate pour deux raisons
cumulées, toutes deux vérifiées dans un vrai navigateur en `http://` sur le réseau local :

- `navigator.clipboard` n'existe pas hors contexte sécurisé. Toute copie doit passer par
  le repli `execCommand('copy')`, et **aucune lecture** du presse-papiers n'est possible.
- xterm pose `user-select: none` sur ses lignes et gère la sélection lui-même, ce qui rend
  l'appui long sans effet sur téléphone.

D'où le traitement retenu :

- une règle CSS rend les lignes de xterm sélectionnables nativement (`.sg-terminal`), donc
  le geste du système redevient disponible ;
- un bouton **Copier** explicite prend la sélection, ou tout le tampon à défaut ;
- un bouton **Coller** ouvre une zone de texte dans laquelle l'utilisateur colle avec son
  geste natif, seule façon fiable de récupérer le presse-papiers sans contexte sécurisé.

Le terminal donne un shell complet sous ton compte utilisateur. C'est assumé et cohérent
avec le modèle « cercle de confiance », et écrit tel quel dans le README.

---

## 11. Remote control

**Écarté, après vérification.** Remote Control n'est pas atteignable depuis une session
SDK headless, et un interrupteur qui ne ferait rien serait pire que son absence.

Ce qui a été mesuré sur le CLI installé :

- `extraArgs: { 'remote-control': '<nom>' }` est **accepté sans erreur** : la session
  démarre et répond normalement. Mais aucun process n'apparaît (272 avant, 272 après) et
  le daemon local (`~/.claude/daemon.log`) n'enregistre rien. Le drapeau est ignoré.
- `applyFlagSettings({ remoteControlAtStartup: true })` est accepté et observable :
  `initializationResult()` passe `remote_control_auto_enable` de `false` à `true`. Mais
  le nom dit ce qu'il fait, et aucun pont ne démarre pour la session déjà lancée.

C'est cohérent avec ce qu'est la fonctionnalité : Remote Control relie une session
**interactive** (le TUI) à claude.ai pour qu'une autre application la pilote. Une session
headless n'a pas de TUI à relier.

Le champ `remoteControl` a donc été retiré de `ClaudeConfig` : une configuration qui ne
produit aucun effet est du poids mort. Le rajouter le jour où le SDK exposerait un pont
coûte trois lignes.

Côté Codex, `codex remote-control` gère un **daemon app-server** entier, pas une session :
c'est un mode de déploiement alternatif, pas un réglage par conversation.

---

## 12. Frontend

### 12.1 Routes

```
/login
/                       redirection vers le dernier projet, ou l'accueil
/p/:projectId           liste des conversations du projet
/p/:projectId/c/:convId vue conversation (Chat | Terminal | Diff)
/settings               profil, thème, densité
/settings/projects      gestion des projets
/settings/users         admin uniquement
```

### 12.2 Structure d'écran

Desktop : sidebar rétractable, zone de conversation. Les conversations sont listées sous
leur projet, dans un ordre manuel plutôt que par date : projets et conversations portent
chacun une colonne `position`, réécrite en bloc par le glisser-déposer. Réécrire toutes
les positions d'un coup évite les trous et les égalités qu'un déplacement unitaire
finirait par produire.

Le repli de la sidebar est conservé d'une session à l'autre (`localStorage`), et laisse un
bouton de réaffichage dans le coin haut-gauche. Ce bouton a d'abord eu sa gouttière, une
colonne décalée de sa largeur : elle laissait une bande vide sur toute la hauteur de
l'écran pour un bouton haut de 40 px. Ce sont maintenant les vues qui ont un en-tête qui
lui réservent sa place, dans cet en-tête, où il se lit comme un contrôle de la barre plutôt
que comme un objet flottant. Les autres vues centrent leur contenu et le laissent passer.

Le repli est publié par un petit magasin (`lib/sidebar.ts`) plutôt que par un contexte :
les vues qui doivent le connaître ne sont pas dans la même branche que la sidebar, et le
faire descendre par les props aurait traversé toute la coque pour une classe CSS.

**Largeur ajustable à la poignée**, sur le bord droit et sur grand écran seulement. La
sidebar commence au bord gauche de la fenêtre, donc l'abscisse du pointeur *est* la largeur
voulue : rien à mémoriser au début du geste. La valeur est écrite dans une variable CSS
plutôt que remontée en état React, comme la hauteur du viewport visuel : le glissement émet
un événement par image, et re-rendre la liste des conversations à chacun rendrait la
poignée pâteuse. `localStorage` n'est écrit qu'au relâchement. Les flèches gauche et droite
font la même chose au clavier, par pas de 16 px, sans quoi le réglage n'existerait qu'à la
souris. Bornes : 200 px, en deçà desquels un titre ne tient plus, et 480 px.

Le tiroir mobile garde la largeur de base (`--sidebar-width`), la poignée n'agissant que sur
`--sidebar-desktop-width` : une largeur choisie au clavier peut dépasser celle d'un
téléphone, et un tiroir en surimpression n'a de toute façon rien à ajuster.

**Renommer se fait au double-clic** sur le nom, en plus de l'entrée de menu. Le nom actuel
est présélectionné à l'ouverture du champ : renommer part presque toujours d'un titre
proposé par le CLI qu'on remplace en entier, et un curseur posé en fin de ligne obligeait à
tout effacer à la main. Le premier des deux clics navigue quand même, puisque la cible est
un lien ; ouvrir ce qu'on renomme n'a rien de gênant.

**Deux niveaux, deux traitements typographiques.** Le projet porte son nom en gras et à
pleine encre, la conversation en plus petit et en encre atténuée. Avec le même corps et la
même couleur pour les deux, l'indentation restait le seul indice de hiérarchie et la
navigation se lisait comme une liste plate. La conversation ouverte repasse à pleine encre,
la sélection primant sur le rang.

Mobile : pas de sidebar. Un en-tête compact avec le nom de la conversation et un bouton
qui ouvre la liste en plein écran. Les métadonnées du fil (modèle, worktree, provenance,
consommation) y sont repliées derrière un chevron : quatre pastilles écrasées dans 390 px
ne se lisent plus, et ce sont des repères qu'on consulte de temps en temps.

**L'application est un calque fixe dimensionné sur le viewport visuel**, remonté de
`visualViewport.offsetTop`, et le document lui-même ne défile jamais (`overflow: hidden`
sur `html` et `body`). À l'ouverture du clavier, tout est donc compressé et poussé vers le
haut, au lieu que la barre de saisie passe dessous : `100dvh` continue de valoir la
hauteur de l'écran entier, et `visualViewport` est la seule mesure qui suive le clavier.
Chaque vue porte alors son propre défilement, puisque le document n'en a plus.

**Les encoches de l'appareil passent par des variables** (`--sg-safe-top`,
`--sg-safe-bottom`), alimentées par `env()`, plutôt que par des appels directs. Deux
raisons, toutes deux tirées d'un défaut réel : une barre de hauteur fixe doit pouvoir
*ajouter* l'encoche à sa hauteur, ce qu'une classe utilitaire ne sait pas faire ; et ces
valeurs valent zéro dans un navigateur mais pas dans une PWA installée, donc les nommer
permet de rejouer la géométrie d'un iPhone sur un poste de développement au lieu de
découvrir le décalage une fois l'application installée.

**Une barre de hauteur fixe qui descend sous l'encoche ne se fait pas avec `pt-safe`.**
`h-[var(--header-height)]` et `pt-safe` sur le même élément ne se combinent pas : la boîte
garde ses 52 px, le contenu est poussé de 59 px, et il déborde donc *sous* la barre, où la
vue le recouvre. C'est ce qui cassait l'en-tête dans la PWA installée, et restait invisible
au navigateur où l'encoche vaut zéro. La classe `header-bar` ajoute l'encoche à la hauteur
au lieu de la retrancher au contenu.

Une encoche ne se réserve **qu'une fois, par l'élément qui touche réellement le bord** :
le panneau du workspace, même en plein écran, se pose sous l'en-tête de la coque qui a déjà
pris l'encoche haute, donc il ne la reprend pas. La réserver deux fois creusait 59 px de
vide au milieu de l'écran.

**La hauteur du calque n'est imposée que quand le clavier est ouvert.** Elle venait
systématiquement de `visualViewport.height` ; une PWA installée rapporte un viewport visuel
plus court que l'écran sans qu'aucun clavier ne soit là, ce qui laissait une bande vide
sous la barre de saisie. En dessous de 120 px d'écart, la mesure est retirée et `100dvh`
fait foi ; au-delà, c'est le clavier, et le calque se réduit comme avant.

**Aucun zoom à la mise au point d'un champ.** iOS zoome sur toute saisie dont le texte
fait moins de 16 px, et ne dézoome jamais : la page reste décalée avec un défilement
horizontal parasite. Deux protections, parce qu'aucune ne suffit seule : `maximum-scale=1`
dans le meta viewport, et une taille de 16 px imposée aux champs sur pointeur grossier.
Cette règle est écrite **hors de toute couche CSS** : les tailles de texte viennent
d'utilitaires Tailwind, et une règle placée dans `@layer base` leur céderait la place.

**Navigation entre tours.** Deux flèches à droite du fil sautent d'un message utilisateur
au suivant, et le message atteint se signale par un anneau qui s'estompe. La cible est
calculée à partir de la **position de défilement**, pas de l'ensemble des tours visibles :
après un saut, le tour précédent reste visible puisque sa région s'étend jusqu'au message
suivant, et partir du premier visible ramenait donc toujours au même endroit. La réglette
latérale (section 12.2bis) ne s'affiche qu'au-delà de 40rem et demande de viser un trait
de deux pixels : au doigt, elle ne sert à rien. Chaque contrôle a sa gouttière réservée
dans le fil, sinon il recouvre la fin des lignes.

**Une transition de translation porte sur `translate`, pas sur `transform`.** Tailwind v4
pose ses utilitaires de translation sur la propriété CSS `translate`, qui est distincte :
une transition déclarée sur `transform` ne porte sur rien, et le tiroir saute d'un bord à
l'autre. Vérifié en traçant la position image par image plutôt qu'en lisant les classes.

### 12.3 Composition de la barre de saisie

Une ligne de saisie multi-lignes, plus une rangée de contrôles compacts qui restent
accessibles au pouce :

- Sélecteur de modèle
- Sélecteur d'effort
- Sélecteur de mode de permission (Claude) ou mode de collaboration, approbation et
  sandbox (Codex)
- Bouton pièce jointe
- Jauge d'occupation de la fenêtre de contexte
- Bouton d'envoi, qui devient Stop pendant l'exécution

**Les réglages se replient quand la barre est étroite.** En dessous de 34rem de largeur de
composer, les sélecteurs laissent place à un unique bouton qui ouvre une feuille ancrée en
bas, où ils reprennent leur forme de champ, cette fois nommés. Le bouton porte l'état de
**tous** les réglages, pas seulement du modèle (« Sonnet · Moyen · Demander ») : replier ne
doit pas revenir à cacher, sinon il faut ouvrir la feuille pour savoir dans quel mode on
travaille. Le texte se tronque quand il dépasse, ce qui garde l'ordre utile en tête.
Sur téléphone, les quatre pastilles de Codex occupaient toute la barre et repoussaient
l'envoi hors du champ visible. Le seuil est mesuré sur le composer (`@container`) et non
sur la fenêtre : c'est sa largeur qui décide, et elle dépend aussi de la sidebar. Un même
descripteur rend les deux formes, sinon la version repliée dérive de l'autre. Un réglage
qui retire un garde-fou teinte le bouton, faute de quoi il disparaîtrait de la vue.

**File d'attente.** Écrire pendant qu'un tour est en cours ne bloque pas la saisie : le
message est mis en file **côté serveur** et affiché sous l'indicateur d'activité, où sa
position dit ce qu'il est, c'est-à-dire ce que l'agent n'a pas encore lu. Il part seul à
la fin du tour, un à la fois, et peut être retiré avant son départ.

La file vit côté serveur et non dans le CLI, parce que pousser un message en cours de
tour ne fait pas ce qu'on croit. Vérifié sur le CLI installé : le second message s'est
mêlé au tour courant, sa réponse est sortie avant que le premier soit achevé, puis une
seconde fois au tour suivant. Le déterminisme vient donc de Sillage, et le comportement
est identique pour les deux CLI.

Elle est en mémoire : un message qui n'a jamais atteint le CLI n'a pas à survivre à un
redémarrage. Le journal, lui, porte de quoi les clore proprement à la reprise
(`EventLog.openQueuedMessages`), sans quoi le fil rejoué les afficherait pour toujours
comme en attente.

**Infléchir le tour en cours.** Là où le CLI le permet, un second bouton apparaît
pendant un tour, à côté de Stop : le message est pris en compte **immédiatement**, à
l'intérieur du tour déjà commencé, au lieu d'attendre sa fin comme le fait la file.

| | Mécanisme | Disponible |
| --- | --- | --- |
| Codex | `turn/steer` avec `expectedTurnId` | oui |
| Claude Code | aucun équivalent | non |

Les deux gestes ne produisent pas le même résultat, donc lequel s'applique reste le choix
de l'utilisateur : la file est l'action par défaut, infléchir est explicite, et un refus
est rendu tel quel (`steer_unavailable`) plutôt que replié sur la file dans le dos de
l'utilisateur. Le bouton n'existe pas du tout sur Claude, plutôt que d'être proposé puis
refusé, et disparaît hors tour ou quand il n'y a rien à envoyer.

`expectedTurnId` est une précondition du protocole : si le tour s'est terminé entre
l'affichage du bouton et le clic, la requête échoue, ce qui est le comportement voulu.

Vérifié de bout en bout contre un vrai CLI : un tour lancé sur les marées, infléchi vers
les volcans en cours de route, produit **un seul** `turn.started`, deux messages
utilisateur dans le fil, une réponse qui parle bien de volcans, et **aucun**
`message.queued`. Deux détails relevés à cette occasion : le tour garde son identifiant,
et l'app-server renvoie le message en écho sous forme d'item `userMessage`, que le
traducteur ignore déjà pour ne pas l'écrire deux fois.

**Le brouillon survit au changement de conversation.** Le composer est remonté par sa
clé quand la conversation change : le texte tapé et les pièces jointes déjà téléversées
sont donc gardés hors de React (`lib/composer-drafts.ts`), indexés par conversation, et
retrouvés au retour. Un fil pas encore créé range le sien sous son projet, seul repère
disponible avant qu'il existe.

Le brouillon n'est pas persisté d'une session à l'autre : les pièces jointes n'y sont
que des identifiants de fichiers téléversés, que le serveur ramasse comme orphelins, et
un brouillon relu après un redémarrage désignerait des fichiers disparus.

**Bande d'état sous la barre de saisie.** Elle porte les deux informations que l'en-tête
ne donne pas : l'état de la liaison, et si un process CLI tourne encore pour cette
conversation (`warm`). Ce second point n'est pas déductible du statut : une conversation
au repos peut avoir gardé sa session chargée ou l'avoir laissée expirer, et le prochain
message coûte alors le redémarrage du CLI et le rechargement de son contexte.

Les changements de réglage prennent effet au prochain message et sont écrits dans
`conversations.config`. Un changement de modèle en cours de conversation est visible dans
le fil sous forme de séparateur discret.

**Mentions `@`.** Taper `@` ouvre une liste de fichiers du répertoire de travail
(`GET /api/projects/:id/files`), avec correspondance par sous-séquence : `wsx` retrouve
`web/src/index.tsx`. La recherche s'appuie sur `git ls-files --cached --others
--exclude-standard`, avec un parcours de repli hors dépôt. Elle est faite par Sillage et
non déléguée à un CLI : il faudrait sinon un process lancé rien que pour compléter une
saisie, et rien ne serait proposé sur une conversation pas encore démarrée.

Les deux CLI injectent la mention différemment, d'où une couche d'abstraction : le chemin
voyage à côté du texte, et chaque runner l'applique à sa façon.

- **Claude Code** développe lui-même les `@chemin` restés dans le texte. Vérifié sur le
  CLI installé en posant une question sur un fichier mentionné avec tous les outils
  refusés : la réponse est arrivée sans qu'aucun outil ne soit appelé.
- **Codex** attend un élément d'entrée `mention` distinct (`UserInput`), et ne développe
  rien tout seul.

Seuls les chemins réellement choisis dans la liste sont transmis : un `@quelquechose`
tapé à la main ne désigne pas forcément un fichier, et Codex refuse une mention qui ne
pointe nulle part. Le serveur résout ensuite chaque chemin et refuse tout ce qui sort du
répertoire de travail.

### 12.4 Rendu du contenu

- Markdown via `markdown-it`, `html: false` : le HTML brut du modèle est échappé, pas
  interprété.
- Le document est découpé en segments : les blocs de code et les tableaux deviennent des
  composants React qui portent leur barre d'outils, tout le reste reste le HTML de
  markdown-it. Les recréer à la main dans le DOM après coup ne tient plus dès qu'il y a
  un état à gérer.
- Blocs de code : coloration syntaxique (`highlight.js`, chargée à la demande), bascule de
  retour à la ligne **par bloc**, copie, téléchargement avec une extension déduite du
  langage. Aucune détection automatique de langage : sur les extraits courts elle se
  trompe souvent, et un bloc mal coloré se lit plus mal qu'un bloc sans couleur.
- La palette de coloration est définie avec les tokens de thème, pas importée d'une
  feuille toute faite qui ignorerait les thèmes clair, sombre et contrasté.
- Tableaux : pleine largeur, défilement horizontal porté par l'enveloppe pour que les
  colonnes restent alignées, et export CSV conforme à la RFC 4180.
- Listes de tâches `- [ ]` / `- [x]` rendues en vraies cases à cocher, désactivées.
- Le fil n'est pas virtualisé : chaque élément est mémoïsé et le fold renouvelle
  uniquement les objets modifiés, ce qui suffit et évite les sauts de défilement qu'une
  virtualisation introduit sur du contenu de hauteur variable.
- Les deltas de texte sont appliqués par lots de 60 ms, pas un `setState` par token. Sur
  un téléphone, un rendu par token fait chuter le framerate.

### 12.4bis Consommation du compte

Un bouton **Utilisation** dans l'en-tête de conversation ouvre l'équivalent de
`/usage` : les jauges de quota du compte, pas celles de la conversation.

| | Source | Nature |
| --- | --- | --- |
| Claude Code | requête de contrôle `get_usage` | fenêtres nommées + fenêtres par modèle |
| Codex | `account/rateLimits/read` | compteurs par `limit_id` |

**Le format normalisé est une liste, jamais un jeu de champs nommés.** La sonde du CLI
installé renvoie aujourd'hui `five_hour`, `seven_day`, `seven_day_opus`,
`seven_day_sonnet`, `seven_day_oauth_apps`, plus une dizaine de clés encore nulles aux
noms de code (`tangelo`, `iguana_necktie`, `cinder_cove`...), et un tableau
`model_scoped` où la sortie de Fable a fait apparaître sa propre jauge. Figer une liste
côté Sillage obligerait à rebuilder à chaque nouveauté et masquerait en silence tout ce
qui n'aurait pas été prévu.

La lecture parcourt donc tout ce qui est là, retient ce qui a la forme d'une fenêtre
(un taux, une date de remise à zéro), ignore le reste sans le nommer, et affiche une clé
inconnue avec son nom d'origine plutôt que de l'écarter. Les libellés des fenêtres par
modèle viennent du serveur, déjà rédigés.

L'API du SDK s'appelle `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` et sa
documentation annonce que la forme peut changer sans préavis : la normalisation ne
présume donc rien et ne peut pas échouer sur un champ manquant. Une panne de cette sonde
ne prive l'UI que de la consommation.

Deux choix d'affichage, qui ne sont pas des données du CLI : les seuils d'alerte (75 %
et 90 %), et le fait qu'un taux inconnu ne dessine aucune barre plutôt qu'une barre vide,
qui affirmerait un zéro que le CLI n'a pas déclaré. Les montants de crédits ne sont
affichés que si le payload transmet son échelle décimale : afficher 4250 pour 42,50 €
serait pire que de ne rien afficher.

Chaque lecture démarre un process CLI, d'où un cache d'une minute côté serveur et un
bouton de rafraîchissement explicite qui le court-circuite.

### 12.5 Rendu des appels d'outils

Un bandeau replié par appel, avec l'icône de l'outil, son nom, un résumé d'une ligne (le
chemin pour `Read`, la commande pour `Bash`) et l'état (en cours, réussi, échoué, durée).
Déplié : une vue lisible de l'appel, et le payload natif à un clic.

**Ce que dit la ligne repliée.** La **description** de l'appel passe avant tout le reste :
elle dit ce que l'appel cherche à faire, là où la commande ou le chemin ne disent que
comment. Claude Code en joint une à ses appels `Bash` et à ses sous-agents, et « Read
commands section context » vaut mieux qu'un `sed -n '334,364p' CLAUDE.md` tronqué au
milieu, ou qu'un prompt de sous-agent de trois lignes. Elle n'est pas garantie pour
autant : Codex n'en produit aucune, et le repli sur le paramètre identifiant (commande,
chemin, motif) reprend alors la main. Une phrase se rend en police de texte, un fragment
de code en police à chasse fixe. La commande n'est jamais perdue : elle reste sous
l'entrée de l'appel déplié.

**Séparation des fils.** Un fil ne montre que ce que son auteur a produit. Tout ce qui
porte un `parentToolCallId` sort du fil principal : mêlé aux réponses de l'agent, le
travail d'un sous-agent s'y lit comme si c'était lui qui parlait, et deux sous-agents en
parallèle deviennent indémêlables. Le fil principal ne garde donc que l'appel de spawn,
qui garde toujours sa ligne propre et ne rejoint jamais un groupe replié : c'est le seul
repère disant qu'un pan entier du travail s'est fait ailleurs. La consigne et le rapport
restent dans sa carte, à un clic, avec un passage vers le fil complet (section 12.11).

**Bandeau des sous-agents en cours.** Posé entre le fil et la barre de saisie, hors du
flux de défilement. Un sous-agent tourne pendant des minutes, et le fil principal
n'avance pas pendant ce temps : placé dans le flux, l'indicateur partait hors de l'écran
dès qu'on remontait lire ce qui précède, et la conversation avait alors toutes les
apparences d'une session au repos. C'est le défaut qui a motivé tout ce découpage : le
seul signe de vie restant était le compteur d'outils d'un groupe replié. Le bandeau se
déplie sur la liste des sous-agents actifs, et chaque ligne ouvre son fil.

**Regroupement.** Une suite d'appels terminés se replie en une ligne, qui compte les
appels et les échecs : replier ne doit jamais faire disparaître une erreur du champ de
vision. Tant qu'un appel de la suite tourne, elle reste dépliée. Les éléments qui
n'affichent rien (un message d'agent ne portant que des `tool_use`) ne coupent pas la
suite.

**Renderers.** Un registre `Map<toolName, ToolView>` donne à chaque outil un rendu qui
dit ce qu'il a fait plutôt que sous quelle forme le CLI l'a dit : une commande shell
colorée et sa sortie pour `Bash`, le contenu lu débarrassé de la gouttière `cat -n` pour
`Read`, l'extrait remplacé et son remplaçant pour un `Edit` de Claude, un vrai diff en
lignes pour un `Edit` de Codex, une liste de tâches cochées pour `TodoWrite`, la consigne
et le rapport en markdown pour un sous-agent.

Trois niveaux, du plus précis au plus sûr : la vue dédiée, une vue générique qui met en
forme n'importe quel payload (champs courts en liste, champs longs en blocs), et le brut.
Le repli est décidé par la vue à l'exécution, pas par la seule présence du nom dans la
table : rien ne garantit qu'un outil nommé `Edit` porte les champs qu'`Edit` porte
d'habitude, et un CLI peut en changer d'une version à l'autre. Une vue qui ne reconnaît
pas ce qu'on lui donne rend `null` plutôt que de deviner. C'est aussi ce qui fait tenir
la promesse « tous les outils » sans table à maintenir : un serveur MCP inconnu tombe
sur la vue générique, jamais sur rien.

**Le brut reste à un clic.** Une bascule *Lisible / Brut* sur chaque appel déplié rend
l'entrée et la sortie telles qu'elles sont en base. Ce n'est pas un mode dégradé qu'on
cacherait : c'est la seule façon de vérifier qu'une vue ne ment pas, et de retrouver un
champ qu'elle a jugé secondaire. Une vue a le droit de choisir ce qu'elle montre, jamais
d'être la seule chose qu'on puisse consulter.

**Coloration des payloads.** L'entrée est du JSON, colorée comme tel. La sortie est
tantôt du JSON, tantôt du texte, et rien n'est deviné : une chaîne n'est colorée que si
l'appel déclare de quel fichier elle vient, auquel cas l'extension du chemin donne le
langage (highlight.js résout `ts`, `py`, `rs`... comme alias, il n'y a pas de table à
tenir). Une sortie de commande reste donc en clair. Au-delà de 100 Ko, la coloration est
abandonnée : analyser un gros fichier lu bloquerait le fil d'exécution.

Rien de tout cela n'a demandé de migration : le payload natif est conservé en base (I3),
donc une vue ajoutée aujourd'hui s'applique aux conversations d'hier.

### 12.6 Design et thèmes

**La marque.** Un point qui avance, et les rides qu'il laisse derrière lui : trois arcs
qui s'élargissent et s'effacent en s'éloignant, comme les vagues transversales d'un vrai
sillage. Trois instants du même événement, ce qu'un journal contient.

Elle est unie, jamais en dégradé, et tracée en `currentColor` : posée sur `text-accent`,
elle suit le curseur de teinte des réglages, ce qu'un dégradé codé en dur ne saurait pas
faire. Le dégradé ne sert qu'à la tuile des icônes d'application, où la marque est posée
en blanc dessus.

Le tracé existe forcément en plusieurs exemplaires, parce qu'un favicon et un en-tête de
README sont chargés comme des images et n'héritent d'aucun jeton : `docs/brand/README.md`
tient la liste et la règle de mise à jour.

Registre visuel : épuré, dégradés très légers, hiérarchie portée par l'espacement et la
typographie plutôt que par les bordures et les ombres.

Tout passe par des variables CSS, aucune couleur en dur dans les composants :

```css
:root {
  --bg-base, --bg-raised, --bg-overlay
  --fg-primary, --fg-secondary, --fg-muted
  --accent, --accent-fg, --accent-subtle
  --border-subtle, --border-strong
  --success, --warning, --danger
  --gradient-canvas         /* le fond de l'application */
  --gradient-surface        /* le dégradé signature, appliqué aux surfaces élevées */
  --radius-sm/md/lg, --shadow-sm/md
  --font-sans, --font-mono
}
```

Un thème est un objet JSON de ces variables. Trois thèmes livrés (clair, sombre, sombre
contrasté), et un thème personnalisé stocké dans `user_settings`. Le thème est appliqué
par un attribut `data-theme` sur `<html>`, injecté avant l'hydratation pour éviter le
flash de thème clair au chargement.

**Fond de l'application.** Deux halos très diffus posés sur une base légèrement
dégradée. Le halo du bas emprunte une teinte décalée de 45°, comme le dégradé d'accent :
c'est ce qui donne sa profondeur au fond sans qu'il devienne une couleur en soi. Les
trois réglages d'apparence continuent de le piloter, `hue` orientant les halos, `tint`
dosant leur chroma et `lift` ne bougeant que la base, pour ne pas éclaircir les halos en
même temps que les surfaces.

Le thème contrasté n'en porte aucun : il tient sa lisibilité de surfaces strictement
plates, et `--sg-gradient-canvas` y vaut `none`. La règle garde un `background-color` en
dessous, qui sert alors de fond réel.

Accessibilité : contraste AA minimum sur tous les couples texte/fond des thèmes livrés,
cibles tactiles de 44 px minimum, et respect de `prefers-reduced-motion`.

**Palette de coloration syntaxique, choisie dans les réglages.** Dix palettes (Sillage,
Océan, Nuit, Agrume, Cerise, Forêt, Sable, Ardoise, Sobre, Encre), chacune en clair et en
sombre, mémorisées sur l'appareil comme le thème. Chacune ne
redéfinit que les sept jetons `--sg-syn-*` : le reste de l'interface ne bouge pas, et
tout ce qui affiche du code suit d'un coup, du fil aux appels d'outils, des diffs à
l'éditeur, puisque tous lisent les mêmes jetons.

Le choix se pose en attribut `data-syntax` sur `<html>`, et la palette par défaut
s'obtient en **retirant** l'attribut plutôt qu'en dupliquant ses valeurs. Il est appliqué
avant l'hydratation, par le même script que le thème : sinon le premier bloc de code
s'affiche dans la palette par défaut puis change de couleurs sous les yeux.

Les sélecteurs ne sont pas ancrés sur `:root`, et c'est ce qui rend l'aperçu honnête :
chaque bouton porte les deux attributs et montre donc les vraies couleurs de sa palette,
sans que l'application en change. L'extrait d'aperçu porte les sept rôles à la fois, chaînes et
gabarits compris, pour qu'on ne choisisse pas sur une impression partielle.

Le sélecteur est une **grille** et non une liste qui s'enroule, et la coche de sélection
occupe sa place même absente : sans ces deux points, choisir une palette redistribuait les
autres sous les yeux au moment du clic. Vérifié en relevant la position de chaque case,
relative au document, après chacune des dix sélections.

Le thème contrasté garde sa propre palette quoi qu'il arrive, et le dit : son contraste
est ce pour quoi on le choisit, une palette d'ambiance l'annulerait. Même raisonnement que
pour la teinte et l'intensité, déjà neutralisées sur ce thème.

### 12.7 Écran de création

Le CLI se choisit sur deux cartes et non dans une liste déroulante : c'est le choix qui
engage le plus, il n'y en a que deux, et chacun porte la phrase qui le distingue de
l'autre. Descriptive, pas promotionnelle : les deux passent par le même journal et la
même interface, la différence est ailleurs.

Le répertoire de travail suit le même principe, options dépliées plutôt que repliées.
Une liste déroulante cache ce qu'on peut choisir avant qu'on l'ouvre, et ne montre jamais
deux options côte à côte ; quand elles sont peu nombreuses et qu'elles portent une
explication (la branche courante, l'état d'un worktree), les montrer coûte quelques
lignes et évite l'ouverture. Au-delà d'une demi-douzaine, la liste déroulante reprend
l'avantage, et c'est pourquoi la même liste reste déroulante ailleurs dans l'application.

Dans les deux cas la coche du choix retenu occupe une place réservée en permanence :
apparaissant au clic, elle décalerait le libellé de chaque ligne au moment même où on
vise.

### 12.8 Réglages

Rangés par catégorie, chacune une route : elles se partagent, se mettent en favori, et
le bouton retour du téléphone les traverse. Une page unique empilait des cartes sans
rapport, et chaque réglage ajouté allongeait le défilement.

Deux dispositions pour un seul arbre de routes. Sur grand écran, la liste est une colonne
posée à gauche et la section vit à côté ; `/settings` sans section y redirige vers la
première, faute de quoi la colonne de droite serait vide. Au doigt, la liste **est** la
page, et ouvrir une catégorie la remplace, avec un retour vers la liste.

La redirection est conditionnée à la largeur réelle, pas à une classe `hidden` : un
élément caché en CSS reste monté, donc une redirection montée est une redirection
exécutée, et la liste du téléphone se serait redirigée toute seule.

**À propos.** Dernière catégorie, visible de tous : version installée, dernière version
publiée, et les notes de toutes les releases parues depuis (telles quelles depuis
GitHub, donc en anglais). Une pastille discrète sur l'icône signale une mise à jour
disponible, sans toast : la mise à jour attend sans presser. L'action de mise à jour
est réservée aux administrateurs et n'apparaît que sur le canal `installer` ; en
Docker, l'écran affiche la commande `docker pull` équivalente. Pendant la mise à jour,
la progression est sondée sur `/api/system/update/status`, puis le client sonde
`/api/health` jusqu'à ce que la nouvelle version réponde et se recharge.

**Confort de lecture.** Trois réglages qui ne touchent qu'au texte des messages : taille,
interligne, et douceur de l'encre. Agrandir la conversation ne doit pas déplacer la barre
latérale ni la barre de saisie, donc ils vivent sur une classe posée sur le rendu markdown
et non sur la racine du document.

La douceur mélange l'encre vers sa nuance atténuée (`color-mix`) plutôt que de baisser une
opacité : un texte translucide laisse passer le fond, et un même message ne se lirait pas
pareil dans une bulle et hors d'elle. Elle répond au blanc pur sur fond très sombre, dur à
lire longtemps.

Ils passent par le même mécanisme que la teinte et la luminosité : variables CSS sur
`<html>`, mémorisées en `localStorage`, appliquées avant l'hydratation par le script de
`index.html` qui doit rester aligné sur `APPEARANCE_SETTINGS`. La remise à zéro est bornée
aux curseurs affichés : le bouton posé sous la typographie ne doit pas emporter la teinte
choisie ailleurs.

L'aperçu est une fausse conversation qui réutilise les vrais composants du fil, bulle
comprise, plutôt qu'une imitation qui finirait par diverger. Rien ne lui est transmis :
les réglages étant sur `<html>`, il suit comme le reste.

### 12.9 PWA

- `manifest.webmanifest` : `display: standalone`, icônes 192/512 et maskable, `theme_color`
  aligné sur le thème actif.
- Service worker (Workbox) : précache de la coque applicative, `NetworkOnly` sur `/api`.
  Aucune mise en cache des réponses d'API, ce serait une source d'incohérence avec le
  journal.
- **Mise à jour annoncée, en mode `prompt`.** Le mode `autoUpdate` fait bien prendre le
  contrôle au nouveau service worker, mais la page déjà chargée continue de tourner sur
  l'ancien code : rien ne la prévient, rien ne la recharge. Le fichier d'enregistrement
  généré se limitait à `navigator.serviceWorker.register('/sw.js')`. Sur une PWA installée,
  qui reprend depuis la mémoire au lieu de naviguer, une correction déployée pouvait donc
  n'atteindre l'écran qu'après une fermeture complète de l'application, et « je ne vois pas
  la correction » était une observation juste.

  L'enregistrement se fait maintenant depuis l'application, une bannière annonce la
  nouvelle version, et le rechargement est proposé plutôt qu'imposé : le déclencher
  d'autorité perdrait un message en cours de saisie. Une revérification périodique
  (30 min) est nécessaire parce qu'une PWA installée ne navigue presque jamais, et que
  c'est la navigation qui déclenche normalement le contrôle des mises à jour.

  Vérifié en servant réellement deux builds distincts : la page reste sur l'ancien tant que
  rien n'est vérifié, la bannière apparaît après la vérification, le rechargement amène le
  nouveau code, et rien n'apparaît quand rien n'a changé.
- **La version installée est affichée dans les réglages.** Sans ce repère, « je ne vois pas
  la correction » ne se tranche pas : rien à l'écran ne dit quelle version tourne.
- Offline : la coque se charge et affiche un état « hors ligne » explicite, avec les
  derniers messages lus depuis IndexedDB en lecture seule.
- Notifications push (Web Push, VAPID) pour deux événements : une permission est demandée
  et attend, ou une conversation est terminée. C'est ce qui rend l'usage mobile réellement
  confortable : tu lances une tâche, tu ranges ton téléphone, tu es rappelé quand l'agent
  a besoin de toi. Prévu au lot 5, pas en v1.

### 12.10 Recherche

Deux surfaces, une seule palette (Cmd+K, Ctrl+K, et une entrée dans la sidebar puisque le
raccourci n'existe pas au doigt).

**Les titres ne passent pas par l'index.** La liste complète des conversations est déjà
chargée pour la navigation : les filtrer en mémoire répond à la frappe sans aller-retour,
et par sous-séquence, si bien que « poigne » retrouve « Poignée de sidebar ». Le contenu,
lui, arrive du serveur une fois la saisie stabilisée (200 ms, à partir de 3 caractères),
dans une seconde section. Deux sections plutôt qu'une bascule à mémoriser : chacune répond
à une intention distincte et elles se distinguent au premier coup d'œil.

**L'index est dérivé, jamais une source** (invariant I2). Table FTS5 `search_messages`
alimentée dans la transaction d'écriture du journal, donc elle ne peut pas contenir un
message que le journal n'aurait pas. Trois conséquences, toutes livrées avec :

- l'extraction est écrite **une fois, en SQL**, et sert aux trois usages : le message qui
  arrive, le fil copié par un fork (qui n'emprunte pas `append`, et resterait sinon
  introuvable), la reconstruction complète ;
- les suppressions sont explicites, une table virtuelle FTS5 ne recevant aucun
  `ON DELETE CASCADE` : conversation supprimée, projet supprimé et ses fils en cascade ;
- `pnpm --filter @sillage/server search:reindex` vide et rejoue. C'est ce chemin qui
  rattrapera l'existant le jour où le contenu indexé changera.

Ce qui est indexé : les blocs de texte des `message.completed`, rien d'autre. Pas les
deltas de streaming, qui décrivent le même contenu en cours d'écriture ; pas la réflexion ;
pas les outils. Cette dernière exclusion est un choix de volume mesuré, pas une facilité :
sur une base peu remplie, `tool.completed` pèse déjà 3,4 Ko par appel contre 0,4 Ko par
message, et indexer les sorties d'outils revient à indexer le contenu des fichiers lus.

Trois points de rigueur dans la requête :

- la **visibilité est appliquée en SQL**, pas après coup : un extrait de projet privé qui
  remonterait jusqu'à la couche HTTP aurait déjà fuité si un filtre y était oublié un jour.
  La jointure sur `conversations` rend au passage les lignes orphelines invisibles ;
- la saisie est **citée terme à terme** avant d'entrer dans la syntaxe FTS5, avec un
  préfixe sur le dernier terme puisque la frappe est encore en cours. Sans ça, un `"` ou un
  `-` tapé au milieu d'une phrase fait échouer la requête entière ;
- les extraits arrivent bornés par deux caractères de contrôle plutôt que par du balisage.
  Rendre du HTML venu de la base demanderait de lui faire confiance ; ces bornes se
  découpent en texte pur.

Le tokenizer est `unicode61 remove_diacritics 2` : « reglage » trouve « réglage ». Le
classement est celui de `bm25`.

**Un résultat ouvre le message, pas le fil.** L'URL porte `?seq=`, et la vue défile jusqu'au
message en le signalant par l'anneau qui existe déjà pour le saut entre tours. Le journal
étant chargé en entier, il n'y a pas de chargement partiel à inventer ; ce sera le moment
de le faire quand les fils seront assez longs pour que le chargement complet gêne.

Les conversations archivées sont exclues, comme partout ailleurs : la recherche voit ce que
la navigation voit.

**Recherche dans le fil ouvert** (Cmd+F, Ctrl+F, et une entrée dans le menu de la
conversation, ouverte aussi aux lecteurs d'un fil partagé). Tout se passe côté client : le
fil est déjà chargé en entier, donc interroger le serveur reviendrait à redemander ce qu'on
a sous les yeux. Le raccourci prend la place de la recherche du navigateur, qui ne sait ni
compter les occurrences ni sauter de l'une à l'autre dans un conteneur qui défile seul ;
elle reste atteignable par le menu du navigateur.

La recherche travaille sur le **DOM** et non sur les éléments du fold : c'est le seul moyen
de trouver aussi ce que produit le rendu markdown et le contenu des appels d'outils. Le
texte visible est reconstitué d'un bloc, avec une table qui ramène chaque position au nœud
et à l'offset d'origine, si bien qu'un terme coupé par un `<strong>` compte comme les
autres. Le repli des accents se fait caractère par caractère : « é » se décompose en deux
caractères, donc une normalisation globale décalerait toutes les positions suivantes et le
surlignage tomberait à côté.

Le surlignage passe par l'**API Custom Highlight**, qui colore des plages sans modifier le
document. Insérer des balises casserait le rendu markdown et les blocs de code. Là où
l'API manque, le défilement seul situe l'occurrence.

**Un défaut trouvé en chemin, et qui dépassait la recherche.** Les plages posées sur les
messages utilisateur se repliaient toutes seules : le navigateur réancre une plage quand
son nœud de texte quitte le document. En remontant, la cause était la fonction `fork`,
recréée à chaque rendu et passée telle quelle aux bulles utilisateur : elle cassait leur
mémoïsation, et le fil entier était redessiné à chaque événement de défilement. C'est
exactement ce que le `memo` de `MessageBubble` prétendait éviter. La fonction est devenue
stable, et la barre relit ses occurrences si elle en trouve une repliée, le fil pouvant
toujours changer sous elle pendant qu'un tour se déroule.

### 12.11 Panneau du workspace

Troisième colonne à droite, dépliable, largeur à la poignée et mémorisée, comme la
sidebar. Sur téléphone il ne peut pas coexister avec le fil dans 390 px : il devient une
vue plein écran, ouverte depuis l'en-tête de la conversation.

Il suit le répertoire de travail de la **conversation** ouverte, worktree compris, et non
la racine du projet : c'est là que l'agent écrit.

**Ouverture et fermeture glissées**, comme le tiroir de navigation : translation au
doigt, où le panneau se pose par-dessus le fil, et fermeture de la marge sur grand écran,
où il occupe une colonne. Le panneau reste monté le temps de sortir de l'écran, puis
disparaît : il tient des terminaux vivants et des requêtes d'arborescence, qu'on ne veut
pas garder derrière un panneau fermé. À l'inverse, l'entrée n'est lancée qu'au rendu
suivant le montage, un élément qui naît déjà en place n'ayant aucune transition à jouer.

**La barre d'onglets ne chasse jamais ses actions.** Les onglets vivent dans une zone qui
défile, le rafraîchissement et la fermeture dans un bloc qui ne se comprime pas : au doigt,
les onglets nommés poussaient la croix hors de l'écran et le panneau ne pouvait plus se
refermer. Les noms demandent plus de place que n'en offrent un téléphone ou la largeur
par défaut du panneau : en dessous, seul l'onglet actif garde le sien, ce qui dit où
l'on est sans que la liste ait à défiler. Le nom reste porté par `aria-label` et `title`
même quand il n'est plus écrit. L'invariant I2 ne s'y applique pas :
un fichier et un diff sont l'état vivant du disque, pas des événements, donc le panneau
lit le disque et n'écrit jamais dans le journal.

Effet de bord voulu : le composer se replie sur la largeur de son conteneur (`@container`),
donc ouvrir le panneau bascule ses réglages en feuille sans une ligne de plus. Mesuré à
416 px de composer sur une fenêtre de 1024 px, sidebar et panneau ouverts.

**Explorateur.** Un niveau par requête : un `node_modules` déplié d'un coup pèse des
mégaoctets. Tout chemin est borné au workspace par la même règle que les mentions `@`,
faute de quoi un `..` donnerait à quiconque a accès à un projet partagé un navigateur de
fichiers sur toute la machine. `.git` est masqué, les autres fichiers cachés non :
`.gitignore` est du contenu comme un autre.

Les couleurs viennent d'un seul `git status --porcelain -z --untracked-files=all
--ignored=matching` pour tout le dépôt. Un appel par fichier serait ruineux dans un dossier
de plusieurs centaines d'entrées. **Un dossier porte l'état le plus notable de ce qu'il
contient**, sinon il faudrait tout déplier pour trouver ce qui a changé : chaque ancêtre
d'un fichier modifié hérite de son état, à n'importe quelle profondeur. L'état est doublé
d'une lettre (`M`, `A`, `D`, `?`) : distinguer cinq teintes proches est difficile, et
impossible pour qui perçoit mal les couleurs.

**`ignored` ne remonte pas aux ancêtres**, et c'est le seul état dans ce cas. Il le faisait,
et le résultat était trompeur : un `node_modules` ou un `dist` quelque part suffisait à
griser tout le chemin jusqu'à la racine, si bien qu'un dossier réellement modifié
s'affichait comme exclu du versionnement. Un dossier ignoré à l'intérieur d'un dossier
versionné ne dit rien du parent ; seul un dossier que git déclare ignoré lui-même l'est.

**Icônes de fichiers** : le jeu de VS Code (`material-icon-theme`), avec sa table de
correspondance officielle (1378 extensions, 2131 noms exacts comme `package.json` ou
`Dockerfile`, 4654 noms de dossiers, variantes ouvertes comprises). Aucune table n'est
écrite ici. Les 1250 SVG sont copiés dans `public/file-icons` par `pnpm icons:sync` et
servis en statique : les inclure dans le paquet ajouterait 240 Ko compressés pour des
icônes dont on affiche une poignée à la fois, et le précache du service worker les
téléchargerait toutes à chaque mise à jour (ses `globPatterns` ne listent pas les SVG).
Seule la table entre dans le paquet, ~50 Ko compressés dans le fragment du panneau.

**Manipulations de fichiers** : créer, renommer, déplacer, supprimer, pour les fichiers
comme pour les dossiers. Renommer et déplacer sont la **même route** : seul le chemin de
destination change, et en faire deux obligerait l'interface à décider laquelle appeler à
partir du chemin. Le déplacement se fait aussi au glisser-déposer, un fichier renvoyant
son dépôt à son dossier parent.

Quatre refus, côté serveur et non côté interface : tout chemin traversant `.git` (le
masquer dans l'arborescence n'est pas un garde-fou, et renommer le stockage de git
détruirait l'historique), une destination déjà occupée, un dossier déplacé dans sa propre
descendance, et la suppression de la racine. Le bornage au workspace est celui qui refuse
déjà les mentions `@` hors périmètre, et il vit avec la résolution de chemin qu'il protège.
Le contrôle de visibilité, lui, a été factorisé : il était recopié dans trois routes du
panneau, soit trois endroits où l'oublier.

Rafraîchi à la **fin d'un tour**, moment où l'arborescence a réellement bougé, plus un
bouton. Aucun sondage en boucle : pendant le tour, les fichiers changent à chaque écriture
et relire à chaque événement ferait clignoter la liste sans rien apprendre.

**Droits.** Tout compte qui voit le projet peut utiliser le panneau, y compris en écriture
quand l'éditeur et les terminaux arriveront. C'est cohérent avec l'idée d'un projet
partagé, mais un terminal exécute des commandes arbitraires sous le compte Unix du daemon,
donc sur toute la machine et pas seulement sur le workspace : à réserver à des comptes
administrés par le propriétaire de l'instance.

**Gestes de l'explorateur.** Un dossier se déplie au clic simple, c'est ce qu'on attend
de lui. Un fichier, non : le clic simple ne fait que le désigner, le double clic l'ouvre.
Ouvrir au premier clic remplissait la barre d'onglets en parcourant l'arborescence, et
empêchait de viser une ligne pour la renommer sans en subir l'ouverture.

Le clic droit ouvre les mêmes actions que les trois points de la ligne. Les deux menus
viennent de modules Radix distincts, dont les éléments ne se partagent pas : les actions
sont donc décrites une fois en données et rendues deux fois, pour que les listes ne
divergent pas. Parmi elles, « Référencer dans le prompt » insère `@chemin` dans la barre
de saisie et l'ajoute aux mentions retenues, comme s'il avait été choisi dans la liste de
complétion.

**Recherche de fichier.** Une requête à part de l'arborescence, qui est paginée par
niveau : chercher demande de traverser, et traverser depuis le client ferait une requête
par dossier. Sous-chaîne insensible à la casse et aux accents, pas de correspondance
floue : sur une arborescence de projet le flou remonte surtout du bruit, et on tape
presque toujours un morceau exact du nom. Les correspondances sur le nom passent avant
celles sur le chemin, et les plus courtes avant les plus longues. La marche saute les
dossiers de dépendances et de construction, et reste bornée en nombre d'entrées visitées :
un répertoire de travail peut être n'importe quoi, y compris un point de montage réseau.
Une liste tronquée le dit, faute de quoi « aucun résultat » mentirait.

Les résultats remplacent l'arborescence au lieu de la filtrer sur place : les niveaux
dépliés doivent être retrouvés intacts en effaçant la recherche.

**Onglets et éditeur.** Un clic sur un fichier de l'explorateur l'ouvre en onglet et
bascule sur l'éditeur : l'ouvrir sans le montrer ne servirait à rien. Les deux vues
restent montées, pour qu'un aller-retour ne replie pas l'arborescence ni ne relise le
fichier.

CodeMirror 6 plutôt que Monaco : le second pèse vingt fois plus et n'apporte ici que ce
dont on se prive volontairement (LSP, autocomplétion). Le nécessaire est monté
explicitement plutôt que par `basicSetup`, qui embarque justement l'autocomplétion et le
linting. Les modes de langage sont chargés à la demande, comme highlight.js pour le fil, et
une extension inconnue ne colore rien plutôt que d'appliquer un mode approximatif.

Aux grammaires Lezer officielles s'ajoutent les modes hérités de CodeMirror 5
(`@codemirror/legacy-modes`), moins fins mais qui couvrent d'un seul paquet le shell,
TOML, INI, Dockerfile et une vingtaine d'autres. Colorer approximativement vaut mieux que
laisser un fichier tout blanc, ce qui restait le cas de la moitié d'un dépôt réel.

Le mode se décide sur le **nom** du fichier, pas sur son extension au sens de Node :
`extname('.env')` rend une chaîne vide, un fichier qui commence par un point n'ayant pas
d'extension mais un nom. C'est pour ça qu'un `.env` s'affichait tout blanc, commentaires
compris. Une table de préfixes couvre `.env.local`, `Dockerfile.dev` et consorts.

Le thème n'est pas importé : il est écrit sur les mêmes jetons `--sg-syn-*` que la
coloration des blocs de code du fil, en `var()` et non en couleurs résolues, donc changer de
thème ou de teinte déplace l'éditeur avec. Vérifié au navigateur : un mot-clé rend
exactement `--sg-syn-keyword`.

**Le point délicat n'est pas l'éditeur, c'est que l'agent écrit dans les mêmes fichiers.**
La lecture renvoie une empreinte (taille et date de modification, ce que le système donne
sans relire le fichier), l'enregistrement la repasse, et le serveur répond 409 si elle a
changé. Sans ça, enregistrer écrase en silence ce que l'agent vient de faire, et la perte
ne se remarque qu'une heure plus tard. Le conflit se présente comme une décision et non
comme un échec : recharger, ou écraser sciemment (`fingerprint: null`). Vérifié en
réécrivant réellement le fichier sous l'éditeur, dans les deux branches, y compris le fait
que le disque reste intact tant que rien n'est tranché.

Fichiers binaires (octet nul dans les 8 premiers Ko) et fichiers de plus de 2 Mo refusés
avec le motif affiché. Les images sont rendues comme images, servies par une route brute
restreinte à une liste fermée d'extensions : servir n'importe quel binaire avec un type
deviné inviterait le navigateur à l'interpréter. Un SVG part avec une CSP qui le rend
inerte, un SVG étant un document capable de porter du script.

Le panneau entier est chargé à la demande (`lazy`) : l'y laisser dans le paquet initial
le faisait passer de 250 à 365 Ko compressés, payés à chaque ouverture de conversation
pour une vue qu'on n'ouvre pas toujours. Il forme maintenant un fragment de 110 Ko chargé
au premier clic.

**Les onglets se réorganisent** au glisser-déposer, se ferment au clic du milieu, et un
menu propose « Fermer les autres » et « Fermer tout ». L'ordre d'ouverture ne dit rien de
l'usage : on regroupe volontiers ce qui va ensemble.

Le panneau de recherche de CodeMirror est habillé par nos jetons et traduit par la facette
`phrases` qu'il prévoit pour ça : ses champs et boutons natifs restaient blancs quel que
soit le thème, donc illisibles en sombre. Il est ancré en haut plutôt qu'en bas, où il
occupait la moitié de la hauteur d'un panneau étroit. `Ctrl+F` depuis le panneau cherche
dans le fichier et non dans le fil : sans ce partage, le raccourci ouvrait les deux
recherches à la fois.

Un seul onglet est monté à la fois : garder les autres en vie retiendrait autant
d'éditeurs CodeMirror que d'onglets ouverts. Le contenu non enregistré d'un onglet quitté
est donc perdu, et la pastille le signale tant qu'il est actif.

**Modifications**, en deux sections qui répondent à deux questions différentes.

En haut, **où en est le dépôt** : la branche courante, le nombre de fichiers touchés avec
les totaux de lignes, le dernier commit, puis le diff du répertoire de travail contre HEAD,
tous auteurs confondus, via `readWorkingDiff`, qui est réellement en lecture seule (il passe
par un index temporaire, le dépôt n'est jamais touché). Le dernier commit est affiché parce
qu'un diff vide a deux causes qu'on ne distingue pas autrement : rien n'a été touché, ou
l'agent vient de commiter ce qu'il a fait. Le worktree n'y figure pas, l'en-tête de la
conversation le porte déjà.

**Les diffs sont colorés**, comme les blocs de code du fil : mêmes jetons `--sg-syn-*`,
même bibliothèque chargée à la demande, langage déduit de l'extension du fichier et non
deviné. La coloration se fait ligne à ligne, un diff n'étant pas du code continu : ses
lignes supprimées et ajoutées ne coexistent nulle part. Un commentaire multiligne peut
donc être coloré de travers, ce que `ignoreIllegals` rend inoffensif et que la lecture
d'un diff pardonne. Les fonds vert et rouge restent sous la coloration, qui ne remplace
pas la lecture de ce qui a changé. Un contenu écrit sans diff auquel le comparer (une
réécriture entière côté Claude) reste du code et se colore comme le reste.

Le diff est relu à la fin d'un tour, **à chaque ouverture du panneau**, et à la demande. Ce
deuxième point était le manque : un agent qui commitait pendant que le panneau était fermé
laissait le cache servir un diff périmé à la réouverture, et l'état courant restait celui
d'avant le commit.

**Deux gestes distincts sur un fichier modifié**, plutôt qu'un seul ambigu : le clic sur la
ligne déplie le diff sur place, et « Ouvrir dans l'éditeur » bascule sur l'onglet Éditeur.
Le diff reste donc là où l'on regarde les diffs, l'éditeur montre l'état actuel du fichier,
et aucun des deux ne prétend faire le travail de l'autre. Le clic ouvrait bien l'onglet
auparavant mais sans y basculer, ce qui donnait l'impression que rien ne se passait. Le patch unifié est découpé côté client
en sections et en lignes numérotées des deux côtés, sans nouvelle dépendance : le format
est celui que git produit, et les bibliothèques du domaine servent surtout à *calculer* un
diff, ce que git fait déjà. Les numéros de ligne ne se sélectionnent pas, pour que copier un
extrait donne du code et non du code numéroté.

En bas, **ce que l'agent a fait**, tour par tour, dérivé du seul journal via un événement
normalisé `file.edited { toolCallId, path, action }`. Deviner côté client à partir des noms
d'outils aurait mis la connaissance de chaque CLI dans le frontend, ce que l'invariant I3
interdit. Les modifications sont regroupées par message utilisateur plutôt que par
`turn.started` : c'est la demande qui donne son sens à une série de modifications, et
l'ordre des deux événements diffère selon le CLI. Contrepartie assumée : les conversations
antérieures n'ont pas d'historique, l'événement n'existait pas.

**Chaque modification d'un tour passé se déplie sur son diff.** Il ne peut pas venir de
git, le disque ayant continué d'évoluer depuis : il est reconstitué depuis le payload
natif de l'appel, conservé dans le journal (`raw`), et lu par l'adaptateur du CLI concerné
plutôt que par le frontend (invariant I3). Un fichier repris plusieurs fois dans le même
tour n'apparaît qu'une fois mais garde chaque appel, et les montre l'un après l'autre :
ne retenir que le dernier effacerait les précédents.

Ce que le payload permet d'affirmer diffère selon l'appel, et l'affichage le dit plutôt
que de maquiller :

| Appel | Ce qu'on peut montrer |
| --- | --- |
| `Edit` (Claude) | un vrai diff, mais **de l'extrait remplacé seulement** : les numéros de ligne y sont relatifs à l'extrait, ce qui est annoncé |
| `Write` (Claude) sur un fichier existant | le contenu écrit, sans point de comparaison : l'état précédent n'est nulle part |
| `Write` (Claude) sur un fichier neuf | un diff complet, tout étant ajouté |
| `fileChange` (Codex) | le diff unifié produit par le CLI, complet |

Le diff des extraits Claude est calculé ici, par plus longue sous-séquence commune sur les
lignes : c'est le seul endroit où Sillage doit *calculer* un diff, git le fournissant
partout ailleurs. Au-delà de 2000 lignes, la comparaison est abandonnée au profit d'un
remplacement intégral, qui est vrai et ne coûte rien. Une création ou une suppression n'a
qu'un côté : les deux CLI donnent alors le contenu brut, enveloppé ici dans la forme que
git produirait pour que l'affichage n'ait qu'un seul format à connaître.

**Un défaut corrigé au passage** : la distinction création / réécriture reposait sur une
lecture disque **asynchrone** lancée au début de l'appel. Elle pouvait se résoudre après
que l'outil avait écrit, donc répondre sur un disque déjà modifié, et son garde-fou
pouvait au contraire abandonner la modification si l'appel se terminait d'abord. Un `stat`
synchrone coûte quelques microsecondes et supprime les deux cas.

**Ce que chaque CLI permet d'affirmer n'est pas le même**, et la différence est visible :

| | Source | Suppression | Écriture par le shell |
| --- | --- | --- | --- |
| Claude Code | outils `Write`, `Edit`, `NotebookEdit` | non (pas d'outil de suppression) | non vue |
| Codex | items `fileChange`, avec leur `kind` | oui | non vue (patch natif seulement) |

Côté Claude, la création se distingue de la réécriture en relevant l'existence du fichier
**au début** de l'appel, seul moment où la réponse est encore vraie. Lire le message de
retour (« File created successfully ») marcherait aussi, mais reviendrait à coder en dur une
phrase anglaise que le CLI peut reformuler.

Le SDK Claude déclare un hook `FileChanged` (chemin + `add`/`change`/`unlink`) qui serait la
source idéale, puisqu'il vient du CLI et couvrirait aussi les écritures faites par `Bash`.
Sondé sur 0.3.220 avec le `watchPaths` que `SessionStart` permet de renvoyer : **il ne tire
jamais**, y compris sur des fichiers écrits dans le cwd que le CLI annonce lui-même. D'où le
passage par les outils, et la limite mesurée : un `rm` lancé par Claude n'apparaît pas dans
l'historique, alors que l'état courant, lui, le voit. C'est précisément pourquoi les deux
sections coexistent.

**Terminaux.** Plusieurs sessions par conversation, ouvertes et fermées à la demande,
numérotées d'après ce qui est ouvert plutôt qu'un compteur : fermer la première puis en
rouvrir une ne doit pas donner deux « shell 2 ». Le gestionnaire est indexé par terminal et
non plus par conversation, pour qu'un serveur de développement puisse tourner dans l'un
pendant qu'on lance des commandes dans l'autre. Plafond de 6 par conversation, partagé par
le protocole pour que l'interface grise le bouton au lieu d'attendre un refus.

Le répertoire de travail est celui de la conversation, worktree compris. Le cycle de vie
passe par REST, la sortie par la socket dédiée : c'est la route qui applique le plafond et
rend l'identifiant, alors qu'une socket qui créerait à l'attachement ouvrirait un terminal
de plus à chaque reconnexion.

Un terminal survit au départ de son dernier client, et son entrée survit à son process avec
son dernier écran : un `exit` accidentel ou une commande qui plante ne doivent pas faire
disparaître ce qu'on voulait lire. C'est l'inactivité prolongée qui finit par libérer le pty.
Rien n'est journalisé : la sortie d'un shell n'est pas du contenu de conversation, et la
persister ferait grossir la base sans qu'aucun rendu s'appuie dessus.

**Le copier/coller est ce qui décide si un shell web est utilisable**, et c'est précisément
ce qui ne marche pas ailleurs. `Ctrl+C` doit rester `SIGINT`, seule façon d'arrêter une
commande : la copie passe donc par `Ctrl+Maj+C`, le collage par `Ctrl+Maj+V` et par le clic
droit, qui reste le geste que tout le monde essaie. Vérifié au navigateur, sélection à la
souris comprise, avec le contrôle négatif qui compte : après `Ctrl+C` sur un `sleep 60`, le
shell reprend la main immédiatement.

**Deux défauts trouvés en vérifiant**, tous deux invisibles à la lecture du code :

- ouvrir un terminal ne l'affichait pas, la sélection ne suivant pas la création. Cliquer
  sur « + » sans rien voir changer donne l'impression que rien ne s'est passé ;
- le terminal restait figé à sa largeur de départ, 305 px pour 687 px disponibles. La cause
  n'était ni la mise en page ni la police : `visible` était capturé dans la fermeture de
  l'effet, et valait faux au montage, le terminal se montant pendant le rendu où la
  sélection d'onglet n'est pas encore faite. `FitAddon` proposait bien 87 colonnes, mais le
  redimensionnement sortait avant. La valeur passe maintenant par une ref, lue au moment de
  l'appel.

Le second n'a été trouvé qu'en mesurant : un observateur témoin posé sur le même élément
tirait treize fois pendant le glissement, ce qui a écarté la mise en page, puis la sonde a
montré le `visible: false` figé. Le commentaire du code affirmait l'inverse, ce qui rendait
le défaut invisible à la relecture.

**Sous-agents.** Cinquième onglet, seul à ne pas lire le disque : tout son contenu vient
du journal. Un sous-agent n'a pas d'existence côté serveur, c'est un appel d'outil, et
l'identifiant de cet appel lui sert d'identité : `buildSubAgents` regroupe par
`parentToolCallId` ce que le journal porte déjà, sans état parallèle ni requête.

La liste donne, par sous-agent, son type, ce qu'on lui a demandé, son activité du moment,
son nombre d'appels d'outils et un chronomètre. Le chronomètre est tenu par l'affichage
tant que l'appel tourne : le CLI ne publie la durée qu'à la fin, et un compteur qui avance
est le signal le plus direct qu'il se passe encore quelque chose.

Le fil d'un sous-agent est rendu par le **même composant** que le fil principal
(`ChatThread`), avec la même fonction de découpe (`buildRows`) à qui l'on passe
l'identifiant de l'auteur. Ce sont les mêmes événements : leur donner un second rendu
obligerait à tenir deux vues en accord pour un seul contenu. Seuls diffèrent les ajouts
propres à la page, ancres de tours et fork, qui sont optionnels. Les éléments interactifs
(permission, plan, question) n'ont pas d'auteur et restent dans le fil principal, seul
endroit d'où l'on peut y répondre.

Le décompte des sous-agents en cours est porté par l'onglet, où il ne se replie jamais
avec le nom : c'est ce qui signale une activité dont on ne verrait sinon aucune trace,
l'onglet étant fermé.

---

## 13. Authentification

- Argon2id pour les mots de passe (`node-argon2`), paramètres par défaut de la
  bibliothèque.
- Cookie de session opaque de 32 octets, seul son SHA-256 est stocké. Durée 30 jours,
  prolongée à chaque usage.
- Pas d'inscription ouverte. Le premier compte est créé par une commande
  `pnpm sillage user:create`, les suivants par un administrateur depuis `/settings/users`.
- Limitation de débit sur `/api/auth/login` : 5 tentatives par minute et par IP.
- Pas de 2FA en v1. Sillage doit être derrière un reverse proxy ou un VPN, ce qui est
  documenté dans le README.

**Autorisation.** Un utilisateur voit un projet s'il en est propriétaire ou si sa
`visibility` est `shared`. Il ne peut envoyer des messages que dans ses propres
conversations, mais peut lire celles des autres sur un projet partagé. Les décisions de
permission sont réservées au propriétaire de la conversation, et l'événement
`permission.resolved` enregistre qui a décidé.

---

## 14. Pièces jointes

- Envoi multipart, 20 Mo par fichier, 5 fichiers par message. Un message peut n'être
  que des pièces jointes, mais jamais vide des deux.
- Stockage sur disque sous `<données>/attachments/<yyyy>/<mm>/<uuid><ext>`, jamais en
  base : SQLite n'est pas un magasin de blobs et le journal doit rester léger à relire.
- **Type déterminé par le contenu**, jamais par l'extension : celle-ci est choisie par
  l'appelant et ne prouve rien. Un PNG renommé `.txt` est reconnu comme une image.
- Les images d'un format accepté par l'API (jpeg, png, gif, webp) partent en ligne :
  base64 pour Claude, `localImage` avec un chemin pour Codex, chacun selon son
  protocole. Tout le reste est transmis par son chemin absolu, que l'agent ouvre avec
  ses propres outils. La racine de stockage est ajoutée aux dossiers autorisés du
  runner, sans quoi la lecture serait refusée puisqu'elle est hors du workspace.
- Une pièce jointe est téléversée **avant** que la conversation existe, puisqu'une
  conversation naît de son premier message : `conversation_id` reste donc nul jusqu'à
  l'envoi, et le fichier appartient entre-temps à son utilisateur.
- Un fichier déjà envoyé ne peut être ni supprimé ni renvoyé : le journal doit pouvoir
  se rejouer à l'identique (invariant I2).
- Suppression avec la conversation, fichiers du disque compris. La cascade des clés
  étrangères n'efface que les lignes, les fichiers sont retirés explicitement avant.
- Les fichiers téléversés puis abandonnés sont ramassés après 24 heures.

## 15. Déploiement

```
~/.local/share/sillage/
  sillage.db
  attachments/
  worktrees/
  logs/
~/.config/sillage/config.toml
```

`config.toml` :

```toml
[server]
host = "127.0.0.1"
port = 7317

[limits]
max_concurrent_sessions = 3
session_idle_timeout_min = 30
pty_idle_timeout_min = 60

[retention]
archived_events_days = 90

[agents.claude]
binary = "claude"
enabled = true

[agents.codex]
binary = "codex"
enabled = true
```

Trois modes d'installation :

1. **Installeur (`install.sh`)**, le mode de référence. Télécharge le tarball de la
   release (bundle serveur + frontend + node_modules natifs précompilés) dans
   `~/.local/share/sillage/app/releases/vX.Y.Z`, bascule un lien `current` atomique,
   rend l'unité systemd depuis `deploy/sillage.service.tmpl` et démarre le service.
   L'unité pose `SILLAGE_INSTALL_DIR`, ce qui active la mise à jour intégrée :
   l'écran À propos affiche la version installée, les nouveautés publiées depuis, et
   un administrateur peut mettre à jour en un clic (téléchargement, bascule du lien,
   redémarrage via systemd, `Restart=always`).
2. **Docker** (`ghcr.io/marlburrow/sillage`), CLIs agents préinstallés, credentials et
   projets montés depuis l'hôte. `SILLAGE_UPDATE_CHANNEL=docker` désactive la mise à
   jour intégrée : l'UI affiche la commande `docker pull` à la place.
3. **Depuis les sources**, pour le développement (`pnpm dev`) ou un déploiement manuel.

Les releases sont des tags git `vX.Y.Z` : la CI construit tarballs Linux x64/arm64,
image Docker multi-arch et release GitHub à notes générées. La version est figée dans
les bundles à la compilation (`SILLAGE_VERSION`), exposée par `/api/health` et
`/api/system/version`.

Variables d'environnement reconnues : `SILLAGE_HOST` et `SILLAGE_PORT` (priment sur le
TOML), `SILLAGE_CONFIG`, `SILLAGE_DATA_DIR`, `SILLAGE_WEB_ROOT`, `SILLAGE_MIGRATIONS`,
`SILLAGE_INSTALL_DIR`, `SILLAGE_UPDATE_CHANNEL`. Le TOML accepte les clés en snake_case
comme en camelCase.

L'exposition à l'extérieur se fait par Caddy ou par un tunnel (Tailscale, Cloudflare
Tunnel). Sillage n'écoute pas sur `0.0.0.0` par défaut (hors Docker) et ne gère pas TLS
lui-même.

---

## 16. Arborescence

```
sillage/
  apps/
    server/
      src/
        main.ts
        http/            routes Fastify
        ws/              hub WebSocket, abonnements, fan-out
        agents/
          types.ts       interface AgentRunner
          claude/        adaptateur Claude Code
          codex/         adaptateur Codex
          registry.ts
        sessions/        SessionManager, cycle de vie, file d'attente
        events/          EventLog, compaction, rétention
        pty/             PtyManager
        git/             worktrees, branches, diff
        auth/
    web/
      src/
        routes/
        components/
          chat/
          tools/         registre de renderers
          terminal/
        theme/
        lib/             client WS, store, IndexedDB
      public/
  packages/
    protocol/            schémas Zod partagés + types Codex générés
    db/                  schéma Drizzle + migrations
  docs/
    SPEC.md
```

---

## 17. Lots de livraison

**Lot 0 : socle.** Monorepo pnpm, Fastify, Drizzle et migrations, authentification,
CRUD projets, coque du frontend, thème et tokens, build et unité systemd. Critère de
recette : se connecter, créer un projet, le voir dans la sidebar.

**Lot 1 : Claude de bout en bout.** Adaptateur Claude, journal d'événements, hub WS,
chat avec markdown et appels d'outils repliables, permissions interactives, interruption.
Critère de recette : couper le wifi 30 secondes pendant qu'un agent travaille, le rebrancher,
et retrouver l'intégralité du flux sans rechargement de page.

**Lot 2 : Codex.** Livré. Adaptateur app-server, bindings générés et commités avec
détection de dérive (`pnpm codex:types:check`), réglages Codex dans la barre de saisie.
Critère de recette atteint : une conversation Codex produit les mêmes événements
normalisés qu'une conversation Claude, permissions comprises.

Différences constatées à l'usage, qui ne sont pas des manques de Sillage :

- Codex accepte modèle, effort, approbation et sandbox **à chaque tour**, donc un
  changement de réglage n'y demande jamais de relancer le process, contrairement à
  Claude où seules certaines requêtes de contrôle existent.
- Codex ne nomme pas ses fils automatiquement : une conversation Codex garde l'extrait
  de son premier message, là où Claude Code fournit un résumé.
- L'app-server ne chiffre pas de coût, mais annonce un pourcentage de quota
  (`usedPercent`), que Claude Code n'envoie pas.

**Lot 3 : worktrees et diff.** Livré. Création et sélection de worktree au démarrage
d'une conversation, gestion depuis la page projet, onglet Diff.

Deux points tranchés à l'implémentation :

- Le diff passe par un index temporaire (`GIT_INDEX_FILE`). Faire un
  `git add --intent-to-add` sur l'index réel afficherait bien les fichiers non suivis,
  mais modifierait le dépôt de l'utilisateur pour le simple affichage d'un onglet.
- Une branche déjà extraite ailleurs ne peut pas l'être une seconde fois, c'est une
  règle de git. Le message le dit explicitement plutôt que de relayer sa sortie brute.

**Lot 4 : mobile et PWA.** Livré, à une réserve près. Manifest, icônes (dont maskable),
service worker Workbox, gestion du clavier virtuel via `visualViewport`.

Deux points à retenir :

- **L'installation exige HTTPS.** Sur `http://<ip-locale>` le service worker ne
  s'enregistre pas et le manifest n'est pas proposé à l'installation : le navigateur
  réserve les deux aux contextes sécurisés. L'instance de développement est désormais
  jointe en HTTPS par une route d'ingress, donc l'installation et les notifications
  push sont débloquées.
- **Le cookie de session est `Secure` par requête**, pas par variable d'environnement :
  la même instance répond en clair sur le réseau local et en HTTPS derrière l'ingress.
  Un `Secure` global casserait l'accès en clair, son absence priverait l'accès chiffré
  de la protection. `trustProxy` est actif, donc `request.protocol` suit
  `X-Forwarded-Proto`.
- **Le fil n'est pas virtualisé.** À la place, les lignes sont mémoïsées et le fold
  produit un nouvel objet uniquement pour l'élément modifié, ce qui limite chaque lot
  de deltas au redessin d'un seul message. C'est l'essentiel du gain sans le risque
  d'une fenêtre glissante à hauteurs dynamiques, qu'on ajoutera si une conversation
  réellement longue montre que ça ne suffit pas.

**Lot 5 : confort et intégrations.** Reste à faire :

- **Renderers d'outils spécialisés.** Reportés : la coloration syntaxique des payloads
  (section 12.5) couvre le besoin pour l'instant.

Livrés en cours de route, hors découpage initial : prompts utilisateur (questions,
validation de plan, élicitations MCP), mentions `@`, pièces jointes, réglages d'apparence, ordre manuel des
projets et des conversations, réglette de navigation dans le fil.

**Compaction.** Livrée sur les deux CLI, dans le menu d'actions de la conversation.

Elle a d'abord vécu sur la jauge de contexte, qui devenait cliquable : c'était le seul
endroit où la contrainte se voit, mais une jauge cliquable ne dit pas ce que le clic
ferait, et l'apprendre demandait de l'essayer sur une conversation en cours. La jauge est
redevenue un pur indicateur, et l'action porte son nom dans un menu.

| | Mécanisme | Ce qu'il annonce en retour |
| --- | --- | --- |
| Claude Code | commande `/compact` dans un message | `system/status` (`compacting`, puis `compact_result`), `system/compact_boundary` avec `trigger`, `pre_tokens` et `post_tokens` |
| Codex | `thread/compact/start` | item `contextCompaction`, sans compteur |

**Une compaction se nomme, elle ne se déguise pas en réflexion.** Elle passait pour un
tour ordinaire, avec l'indicateur « Réflexion » pendant toute sa durée : sur un fil rempli,
mesuré à 27 secondes, pendant lesquelles on attend une réponse qui ne viendra pas.
`context.compaction_started` ouvre l'état, `context.compacted` le referme, et l'indicateur
annonce la compaction avec la taille du contexte qu'elle est en train de résumer.

Aucun des deux CLI n'annonce d'avancement chiffré, donc il n'y a pas de barre de
progression : elle serait inventée. Ce qui est mesuré est affiché à la fin, Claude
transmettant les deux tailles (« Contexte résumé, 28 k vers 2 k tokens », observé à
27 580 → 2 224). Un échec de compaction n'émet aucune frontière : le message
`compact_result: failed` est relayé en erreur récupérable, sinon le contexte reste plein
sans que rien ne le dise.

Claude n'expose pas de requête de contrôle : `/compact` est une commande de barre oblique,
reconnue dans un message utilisateur ordinaire. Vérifié plutôt que supposé, en observant
la réponse du CLI : sur un fil trop court il répond « Not enough messages to compact »,
et sur un fil rempli il émet `compact_boundary`. Ce message n'est pas journalisé comme
contenu utilisateur : c'est une commande adressée au CLI, pas une phrase dite à l'agent.

L'événement `context.compacted` est journalisé parce que rien d'autre ne le montrerait :
le fil ne perd aucun message à l'écran, mais la mémoire de l'agent a changé. Sans ce
repère, une réponse qui ignore un détail donné plus haut paraît inexplicable. `preTokens`
et `postTokens` sont nullables, Codex ne les transmettant pas ; inventer un chiffre serait
pire.

Compacter pendant un tour est refusé (409) : le contexte bouge encore. L'entrée de menu
est alors grisée plutôt que retirée, pour qu'on voie qu'elle existe et qu'elle reviendra.

Vérifié de bout en bout sur les deux CLI : contexte en baisse (23 926 → 21 588 pour
Claude, 13 463 → 12 569 pour Codex) et le mot mémorisé avant la compaction toujours
restitué après. Compacter résume, ça n'efface pas.

**Un défaut trouvé en chemin.** La jauge de contexte de Codex utilisait
`tokenUsage.total.totalTokens`, qui est le **cumul du fil** et non l'occupation : mesuré
sur quatre tours, 12 570 puis 25 497 puis 38 794 puis 52 475, alors que le contexte réel
passait de 12 228 à 13 313. Rapportée à la fenêtre, cette valeur finit par dépasser 100 %
et ne redescend jamais, pas même après une compaction. C'est `last.inputTokens` qu'il
faut lire, et il inclut déjà la part mise en cache. Un tour sans entrée utilisateur, comme
une compaction, le rapporte à zéro : la jauge n'est alors pas mise à jour, plutôt que
d'annoncer un contexte vide.

**Notifications push.** Livrées. Web Push avec VAPID : le serveur s'authentifie
directement auprès du service de push du navigateur, sans compte chez un tiers. La paire
de clés est propre à l'instance, générée au premier démarrage dans `<data>/vapid.json`.

Trois décisions qui font la différence entre une notification utile et du bruit :

- **Seuls les moments qui réclament l'utilisateur** sont notifiés (permission, question,
  élicitation, plan) plus la fin d'un tour, qu'on ne peut pas deviner de loin. La liste
  est nommée dans le code, pas déduite.
- **Rien n'est envoyé à quelqu'un qui regarde déjà la conversation.** Le socket est le
  signal de présence : un onglet abonné au fil reçoit l'événement en direct, l'avertir en
  plus reviendrait à le prévenir de ce qu'il est en train de lire.
- **Une conversation ne garde qu'une notification affichée** (`tag` = identifiant du
  fil) : empiler « l'agent a terminé » cinq fois ne dit rien de plus que la dernière.

L'abonnement vaut pour un couple compte + appareil. Un endpoint que le service déclare
mort (404, 410) est supprimé, sinon la table accumule des entrées interrogées à chaque
envoi. Un échec d'envoi n'interrompt jamais un agent (invariant I1), mais il est
journalisé avec sa cause : un endpoint injoignable et un contenu refusé ne se
diagnostiquent pas de la même façon.

Les écouteurs vivent dans `public/push-sw.js`, chargé par `importScripts` dans le service
worker généré par Workbox : le précache reste géré par l'outil, sans écrire le service
worker entier à la main.

Vérifié de bout en bout contre un faux service de push : envoi émis avec l'en-tête VAPID
quand personne ne regarde, **aucun** envoi pendant qu'un socket suit le fil, reprise dès
qu'il se ferme, et abonnement retiré sur un 410. Un détail appris à cette occasion :
web-push impose TLS, ce qui est le comportement correct pour un vrai service de push.

**Fork de conversation.** Livré. Forker à un point du fil crée une nouvelle conversation
qui hérite de l'historique jusqu'à ce point, sans toucher à l'originale.

| | Mécanisme | Granularité |
| --- | --- | --- |
| Claude Code | `forkSession(id, { upToMessageId })` | message de transcript |
| Codex | `thread/fork` puis `thread/rollback { numTurns }` sur le fork | tour |

Vérifié de bout en bout des deux côtés, à travers Sillage : après un fork juste avant le
second message, la branche répond « POMME » et l'originale « POMME, BANANE ». Le journal
de la branche s'arrête exactement au point de coupe.

**Le geste.** Le fork se déclenche depuis un message utilisateur, et coupe **avant** lui :
la branche reprend tout ce qui précède, et le message coupé revient dans la barre de
saisie, prêt à être reformulé. C'est ce que le fork sert à faire, et le laisser dans
l'historique de la branche le rendrait inutile. La provenance est affichée dans l'en-tête
et pointe vers l'originale ; sans elle, deux fils presque identiques dans la sidebar sont
impossibles à distinguer.

La colonne `conversations.forked_from_id` n'est pas en cascade : supprimer l'originale ne
doit pas emporter ses branches, qui sont des conversations à part entière. La référence
devient alors orpheline et l'UI cesse simplement d'afficher la provenance.

Le fork ne demande aucun runner vivant : il travaille sur ce que le CLI a persisté, donc
il fonctionne sur une conversation dont la session est arrêtée depuis longtemps. En
revanche une conversation qui n'a jamais démarré n'a rien à brancher, et le dit
(`no_agent_session`).

Deux contraintes tirées de ces essais :

- Côté Claude, `upToMessageId` désigne une entrée du fichier de transcript, pas un
  identifiant d'API. Seules les entrées `user`, `attachment` et `assistant` en portent
  un ; un message `result` n'existe pas dans le transcript et le fork échoue si on le
  désigne. L'`uuid` utilisable est celui que le SDK expose sur les messages `assistant`,
  déjà conservé dans `events.raw` (I3).
- Codex ne sait pas couper à un message, seulement retirer des tours entiers depuis la
  fin. La granularité commune est donc **le tour**, ce qui rejoint le découpage que la
  réglette de navigation utilise déjà.

Le journal de la nouvelle conversation est une copie de celui de l'originale jusqu'au
point de coupe : sans ça, le fil forké serait vide alors que l'agent, lui, se souvient
(I2). Le `thread/rollback` de Codex ne revient pas sur les fichiers déjà modifiés sur le
disque, et cette limite doit être dite à l'utilisateur plutôt que devinée.

**Lot 6 : panneau latéral d'outils.** Chantier non spécifié. Explorateur de fichiers
coloré par état git, édition à onglets, terminaux, et historique des modifications faites
par l'agent. Le terminal du lot 5 y est déjà prêt (section 10).

---

## 18. Points restés ouverts

Ils sont peu nombreux et aucun ne bloque le lot 0 ou le lot 1.

0. **Sous-agents côté Codex.** Le runner Codex câble `parentToolCallId` à `null` : les
   sous-agents y sont donc invisibles, bandeau et onglet restant vides. L'app-server a
   pourtant de quoi les rattacher (`thread_spawn` avec `parent_thread_id`, item
   `subAgentActivity`), non exploité.

2. **Steering.** Livré côté Codex, voir section 12.3. Claude n'a pas d'équivalent, donc
   le bouton n'apparaît que sur les conversations Codex.
