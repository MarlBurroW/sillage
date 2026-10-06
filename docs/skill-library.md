# Bibliothèque de skills : plan d'implémentation

Une bibliothèque de skills tenue par Sillage, livrée à Claude Code, à Codex et à OpenCode
comme des skills natifs : invocables en `/nom` et `$nom`, déclenchés par leur description,
sans rien écrire dans `~/.claude`, `~/.codex` ni `~/.config/opencode`. Même principe que le registre MCP :
déclarés une fois, transmis à chaque lancement, et une conversation reprise dans un CLI
natif ne les a pas.

Décisions validées le 2026-10-04 :

- deux portées, **globale** (admins) et **projet** (propriétaire du projet) ;
- un seul interrupteur par conversation, pas un par skill ;
- pas de masquage d'un skill global dans un seul projet (voir « Limites ») ;
- côté Claude, plugins nommés `sillage` (global) et `projet` (projet).

**Lots 1, 2 et 3 livrés** le 2026-10-04, fusionnés dans `main` après le travail des
autres sessions qui y attendait. La recette du lot 1 a tourné sur un serveur jetable avec de vraies
sessions Claude et Codex : 13 vérifications sur 13, plus le cas `bypassPermissions`.
Les interfaces des lots 2 et 3 ont été parcourues dans un navigateur sur le même
serveur, le lot 3 contre les vrais dépôts GitHub et skills.sh (voir « Lots » plus bas).

## Ce que les sondes ont établi

Sondé le 2026-10-04 sur Claude Code 2.1.286 (SDK 0.3.273) et codex-cli 0.157.1. Scripts
dans `/tmp/skill-probe`, à rejouer si une version de CLI change le comportement.

**Claude, option `plugins` du SDK.**

- Un skill de plugin s'appelle `sillage:nom`, avec l'alias `nom` : `/nom` fonctionne.
  Déclenchement par la description et substitution de `$ARGUMENTS` fonctionnent.
- Lire un fichier annexe du skill (`references/`, `scripts/`) déclenche `canUseTool` si
  le dossier n'est pas dans `additionalDirectories`. À travers un lien symbolique, **les
  deux côtés** doivent y être : la bibliothèque n'utilise donc aucun lien.
- Un skill ajouté en cours de session n'est pas vu tout seul. `reloadSkills()` le prend,
  le CLI pousse `commands_changed` (déjà traité, `claude/runner.ts:533`) et le cache de
  prompt est conservé.
- Un plugin lancé avec un dossier `skills/` **vide** se remplit par `reloadSkills()`. Un
  plugin lancé **sans** dossier `skills/` ne voit jamais ce qu'on y ajoute : les deux
  racines doivent exister dès le lancement.
- Des règles `deny` `Edit(//racine/**)` et `Write(//racine/**)` passées en flag settings
  bloquent l'écriture en `acceptEdits` comme en `bypassPermissions`, et laissent la
  lecture passer. Elles survivent à un `applyFlagSettings` à chaud qui ne nomme pas
  `permissions`.
- Le manifeste `.claude-plugin/plugin.json` est facultatif : sans lui, le plugin prend le
  nom de son dossier.

**Codex, `skills/extraRoots/set`.**

- Accepte un dossier de skills, un skill seul ou un lien. Portée rapportée : `user`.
- Process et non thread : la racine disparaît avec l'app-server. À reposer à chaque
  lancement, avant `thread/start` comme avant `thread/resume`.
- Codex surveille lui-même ses racines : un ajout ou une modification est vu en moins de
  5 s, avec `skills/changed`. Un dossier qui **sort** de la racine (renommage,
  désactivation, suppression) n'est pas vu : il faut reposer les racines, ce qui fait
  tout relire.
- Quand un `.claude-plugin/plugin.json` se trouve au-dessus d'une racine, Codex préfixe
  chaque skill du nom du plugin (`projet:nom`), comme ses propres plugins. Le composer
  cherche par préfixe : `$nom` ne le retrouverait plus. D'où l'absence de manifeste.
- Lit les fichiers annexes par `cat` sous le sandbox `read-only`, sans approbation.
- Ne substitue pas `$ARGUMENTS` : c'est le modèle qui interprète le marqueur.
- `~/.codex/config.toml` reste intact.

**OpenCode, clé `skills.paths` de la configuration injectée.** Sondé le 2026-10-05 sur
opencode 1.18.25, ajouté après la livraison des lots.

- Le dossier `skills/` de chaque racine passe dans `skills.paths`, par
  `OPENCODE_CONFIG_CONTENT` : rien n'est écrit dans `~/.config/opencode`.
- Les skills apparaissent parmi les commandes en `/` (`source: skill`) et dans l'outil
  `skill` du modèle, qui les déclenche par leur description.
- Un skill ajouté après le lancement n'est pas vu. Il faut jeter l'instance
  (`POST /instance/dispose`), ce que le runner fait au repos ; le flux d'événements
  ouvert devient alors muet et doit être rebranché.
- OpenCode lit aussi de lui-même `~/.claude/skills`, `~/.agents/skills`, et les
  `.claude/skills` et `.agents/skills` du dépôt en remontant depuis le dossier de travail.

## Modèle

### Sur disque

La bibliothèque a la forme de deux plugins Claude, dont le dossier `skills/` sert tel
quel de racine Codex. Un seul jeu de fichiers pour les deux CLI.

```
<data>/skill-library/
  global/sillage/skills/<nom>/SKILL.md …              plugin « sillage »
  projects/<projectId>/projet/skills/<nom>/SKILL.md …  plugin « projet »
  disabled/<skillId>/                                  hors de toute racine livrée
  .staging/                                            transit des écritures atomiques
$XDG_CACHE_HOME/sillage/skill-sources/<sourceId>/      clones, régénérables (lot 3)
```

- Aucun manifeste : Claude nomme le plugin d'après son dossier, et Codex garde les noms
  nus (voir les sondes).

- Le nom du dossier est le `name` du frontmatter. Renommer, c'est déplacer le dossier
  et réécrire le frontmatter dans la même opération.
- Désactiver déplace le dossier dans `disabled/`. Ni Claude ni Codex n'offrent de filtre
  qui ne masque pas aussi les skills personnels de l'utilisateur.
- Les racines d'un projet sont créées au premier lancement d'une conversation du
  projet, `skills/` compris, même vide (voir les sondes).
- Les clones de sources vont dans le cache et non dans `<data>` : ils sont régénérables
  et la sauvegarde horaire n'a pas à les transporter.
- Toute écriture passe par un fichier temporaire puis un `rename`, pour qu'un CLI ne lise
  jamais un `SKILL.md` à moitié écrit. Une mise à jour remplace le dossier entier de la
  même façon.

### En base

Le nom `skills` est déjà pris par `packages/protocol/src/skills.ts`, qui décrit les
skills que Codex publie. Tout ce qui suit est préfixé `library` ou `skillSource`.

```ts
// packages/db/src/schema.ts
library_skills
  id               text pk
  scope            'global' | 'project'
  project_id       → projects.id, on delete cascade, null en portée globale
  name             text       nom du dossier, clé d'unicité
  enabled          bool
  source_id        → skill_sources.id, on delete set null
  source_path      text null  chemin du skill dans la source
  source_commit    text null  commit installé
  source_hash      text null  empreinte du skill dans la source, avant renommage
  installed_hash   text null  empreinte du contenu à l'installation
  created_by       → users.id
  created_at, updated_at

skill_sources
  id, name, url, ref (null = branche par défaut), subpath (null = racine)
  builtin bool, enabled bool
  last_commit, last_fetched_at, last_error
  created_at, updated_at
```

- La description n'est pas en base : le `SKILL.md` fait foi, et la liste le relit.
- **Unicité.** Un nom ne peut exister qu'une fois dans l'ensemble « global + un projet
  donné ». SQLite tient les `NULL` pour distincts, donc un index ne suffit pas : c'est le
  service qui contrôle, et qui répond un code d'erreur traduisible, comme
  `requireFreeName` dans `routes/mcp.ts`.
- **Empreinte.** sha256 de la liste triée des `chemin\0sha256(contenu)`. Une empreinte
  locale différente de `installed_hash` donne « modifié localement ». Une empreinte de la
  source différente de `installed_hash` donne « mise à jour disponible ».
- Les deux sources préconfigurées sont insérées par la migration elle-même, et non au
  démarrage, pour qu'une source supprimée ne revienne pas :
  - `anthropics/skills`, sous-dossier `skills` ;
  - `openai/skills`, sous-dossier `skills/.curated`. Pas `.system`, qui doublonnerait les
    skills intégrés à Codex.

### Configuration

- `AgentConfig` : `skillLibrary: z.boolean().default(true)` pour Claude et pour Codex,
  sur le modèle de `sillageMcp` (`packages/protocol/src/agent-config.ts:33`).
- `config.toml` : `[skills] library = true`, interrupteur d'instance comme
  `mcp.sillage_server`.
- `Paths` (`apps/server/src/config.ts:81`) : `skillLibrary` et `skillSourcesCache`.

## Livraison aux CLI

`RunnerContext` reçoit `skillRoots(config): string[]`, les racines de plugin (global, puis
projet) ou un tableau vide si la bibliothèque est coupée pour l'instance ou pour la
conversation. C'est une fonction pour la même raison que `resolveMcpServers` :
l'interrupteur change à chaud. Elle est construite dans `SessionManager.buildContext`,
qui crée les racines au passage.

**Claude** (`claude/runner.ts`, options de `query()`, construites par
`claude/skill-library.ts`) :

- `plugins: roots.map((path) => ({ type: 'local', path, skipMcpDiscovery: true }))` ;
- les racines ajoutées à `additionalDirectories`, à côté de `attachmentsRoot` ;
- dans `flagSettings`, `permissions.deny` sur `Edit(//<racine>/**)` et
  `Write(//<racine>/**)`. C'est un garde-fou contre la modification accidentelle d'un
  skill global par l'agent d'un projet, pas une frontière : Bash peut toujours écrire ;
- des racines différentes rendent `false` dans `applyConfig`, donc un relancement en
  fin de tour par le mécanisme existant : les plugins sont des options de lancement.

**Codex** (`codex/runner.ts`, `start()`) :

- `skills/extraRoots/set` avec `roots.map((root) => join(root, 'skills'))`, juste après
  `initialize` et avant `thread/start` ou `thread/resume` ;
- changer `skillLibrary` rejoue `extraRoots/set` à chaud, avec la liste vide le cas
  échéant ;
- un échec de la méthode n'emporte pas la session, qui tourne sans la bibliothèque ;
- l'inventaire du composer se met à jour seul par `skills/changed`, déjà branché.

**Rechargement après une écriture.** `AgentRunner` gagne `reloadSkillLibrary()`. Côté
Claude, il appelle `session.reloadSkills()`. Côté Codex, il repose les mêmes racines : son
watcher ne voit pas un dossier qui part. `SessionManager.reloadSkillLibrary(projectId |
null)` l'appelle sur les runners concernés : tous pour une écriture globale, ceux du
projet sinon. Le service de la bibliothèque l'appelle après chaque écriture réussie.

## Serveur

Nouveau dossier `apps/server/src/skill-library/` :

| Fichier | Rôle |
|---|---|
| `layout.ts` | chemins des racines, création idempotente des deux plugins |
| `frontmatter.ts` | lecture et écriture du frontmatter (dépendance `yaml`) |
| `validate.ts` | chemins de fichiers relatifs, sans segment vide, `.` ou `..`, `SKILL.md` réservé hors import. Le nom et la description sont validés par les schémas de `packages/protocol/src/skill-library.ts` |
| `compat.ts` | avertissements : `$ARGUMENTS`/`argument-hint` (Codex ne substitue pas), `allowed-tools`, `disable-model-invocation`, `context: fork` (ignorés par Codex), présence de scripts |
| `store.ts` | création, édition, renommage, déplacement de portée, activation, suppression, empreintes, écritures atomiques |
| `archive.ts` | import et export zip/`.skill` (dépendance `fflate`, déjà présente en transitif) |
| `local-scan.ts` | skills déjà présents sur la machine et dans le dépôt du projet |
| `sources.ts` | clone, rafraîchissement, catalogue, installation, mise à jour |
| `skills-sh.ts` | recherche sur skills.sh, isolée parce que l'API n'est pas documentée |

Routes, enregistrées dans `http/app.ts` comme `registerMcpRoutes` :

```
GET    /api/skill-library?projectId=           globaux + ceux du projet + ceux du dépôt (lecture)
POST   /api/skill-library                      créer {scope, projectId?, name, description, body}
GET    /api/skill-library/:id                  détail : frontmatter, corps, arbre, compat, état
PATCH  /api/skill-library/:id                  name, description, body, frontmatter, enabled, scope
DELETE /api/skill-library/:id
GET    /api/skill-library/:id/files/*          lire un fichier annexe
PUT    /api/skill-library/:id/files/*          écrire un fichier texte
POST   /api/skill-library/:id/files            upload multipart (@fastify/multipart)
DELETE /api/skill-library/:id/files/*
GET    /api/skill-library/:id/export           zip
POST   /api/skill-library/import               zip, .skill ou dossier (multipart)
GET    /api/skill-library/local?projectId=     skills trouvés sur la machine et dans le dépôt
POST   /api/skill-library/adopt                copier un skill local dans la bibliothèque

GET    /api/skill-sources
POST   /api/skill-sources                      {name, url, ref?, subpath?}
PATCH  /api/skill-sources/:id
DELETE /api/skill-sources/:id
POST   /api/skill-sources/:id/refresh
GET    /api/skill-sources/:id/catalog
POST   /api/skill-sources/:id/install          {path, scope, projectId?}
GET    /api/skill-library/:id/update           diff entre l'installé et la source
POST   /api/skill-library/:id/update           appliquer
GET    /api/skill-sources/search?q=            skills.sh
```

**Droits.**

- Lecture : tout utilisateur pour le global, les membres du projet pour un projet.
- Écriture globale et sources : `requireAdmin`. Un skill global entre dans le contexte
  de toutes les conversations de l'instance, et ses scripts s'exécutent sous
  l'utilisateur système, au même titre qu'un serveur MCP.
- Écriture projet : le propriétaire, même contrôle que `projects.ts:360`.
- `local` et `adopt` sur `~` : admin seulement, parce que ces routes exposent le
  dossier personnel du compte système. La partie « dépôt du projet » reste visible des
  membres du projet.

**Détails.**

- La suppression d'un projet (`projects.ts:395`) supprime aussi
  `skill-library/projects/<id>/`. La cascade de la base ne touche pas le disque.
- `local-scan` lit `~/.claude/skills`, `~/.agents/skills` et `$CODEX_HOME/skills`, sans
  `.system`, et sans `~/.claude/skills/synced`, géré par la synchronisation du compte
  Claude. Il lit aussi le `.claude/skills` et le `.agents/skills` du workspace. Il sert
  aussi à signaler un homonyme : un skill natif `x` masquerait l'alias `/x` côté Claude,
  et Codex afficherait les deux.
- L'import d'archives refuse les chemins absolus et ceux qui contiennent `..`. Il plafonne
  la taille à `limits.maxAttachmentBytes` et le nombre de fichiers à 500. Il accepte un
  `SKILL.md` à la racine ou dans un unique dossier de premier niveau.
- Le clone réutilise `cloneRepository` (`git.ts:167`) avec `--depth 1` et les identifiants
  git de l'admin qui déclenche l'opération, ce qui couvre les dépôts privés d'une équipe.
  Le rafraîchissement fait `fetch --depth 1` suivi d'un `reset --hard` sur la ref, dans
  le cache uniquement.
- Le catalogue est la liste des dossiers qui contiennent un `SKILL.md`, à quatre niveaux
  au plus, sans `.git` ni `node_modules`. Le résultat est mis en cache à côté du clone.
  Quand la source a un `.claude-plugin/marketplace.json`, il sert à regrouper les skills.
- L'installation est une **copie** figée sur un commit, jamais un lien vivant : rien ne
  doit changer dans le contexte des agents sans qu'un admin l'ait relu. Pas de mise à
  jour automatique.
- Le diff de mise à jour passe par `git diff --no-index` entre l'installé et la source,
  pour réutiliser le format que l'interface sait déjà afficher (`DiffHunks`).
- `skills-sh.ts` appelle `GET https://skills.sh/api/search?q=`, qui renvoie
  `{source: "owner/repo", skillId, installs}`. Installer un résultat ajoute la source
  GitHub correspondante. Si l'API répond mal, la recherche est masquée et le reste
  fonctionne.

## Interface

**Réglages > Skills** (`/settings/skills`) :

- entrée `SECTIONS` dans `routes/SettingsPage.tsx`, groupe `workspace`, après `mcp` ;
- page `routes/SkillLibrarySettingsPage.tsx`, sur le modèle de `McpSettingsPage` :
  visible de tous, éditable par les admins ;
- liste : nom, description, badges d'origine (« créé ici », `anthropics/skills @ abc123`)
  et d'état (« modifié localement », « mise à jour disponible », « désactivé »,
  « scripts ») ;
- bouton « Ajouter » : Nouveau, Importer une archive, Depuis un catalogue, Depuis cette
  machine ;
- section « Sources » sur la même page : liste des dépôts, ajout par URL, rafraîchir,
  dernière erreur.

**Page projet** (`/p/:projectId`) :

- section `ProjectSkills` dans `routes/ProjectPage.tsx`, après les worktrees, hors du bloc
  réservé au propriétaire puisque les membres la lisent ;
- visible des membres, éditable par le propriétaire ;
- contenu : les skills du projet, un rappel des skills globaux en lecture, et les skills
  du dépôt en lecture, avec le CLI qui les voit (`.claude/skills` pour Claude,
  `.agents/skills` pour Codex).

**Éditeur** (`/skills/:skillId`, page en pleine largeur) :

- une seule route pour les deux portées, hors des réglages : la colonne des réglages est
  trop étroite pour les instructions et les fichiers. Le lien de retour mène à la
  bibliothèque ou au projet ;
- champs nom et description, validés en direct. La description porte l'indication « dis
  quand l'utiliser » : c'est elle qui déclenche le skill ;
- corps du `SKILL.md` dans `panel/CodeEditor.tsx`, qui gagne un mode lecture seule pour
  qui ne peut pas écrire ; un seul bouton Enregistrer, et Ctrl+S ;
- fichiers : une liste simple plutôt que `panel/FileTree.tsx`, lié au workspace ;
  création, envoi et suppression, chaque fichier texte ouvert dans un `CodeEditor`. Pas
  de renommage : supprimer et recréer suffit pour l'instant. Le frontmatter avancé en
  YAML n'est pas éditable non plus, les champs propres à un CLI restent intacts à la
  réécriture ;
- panneau de compatibilité alimenté par `compat.ts` ;
- actions : exporter, dupliquer, déplacer entre global et projet, désactiver, supprimer
  (`ConfirmDialog`).

**Catalogue et mises à jour** :

- dialogue de catalogue : choix de la source, liste, aperçu (`SKILL.md` rendu, arborescence,
  badge scripts, commit) puis « Installer » avec choix de la portée ;
- recherche skills.sh en tête du dialogue quand elle répond ;
- dialogue de mise à jour : diff par `DiffHunks`. Si le skill est modifié localement, le
  dialogue l'annonce avant d'écraser.

**Conversation** :

- interrupteur « Bibliothèque de skills » ajouté dans `components/chat/agent-settings.tsx`
  pour les deux CLI, à côté du MCP Sillage. Le même hook alimente le composer, les
  défauts du compte et ceux du projet ;
- rien d'autre à faire dans le composer : les skills arrivent dans `/` par le catalogue
  de commandes de Claude et dans `$` par `skills/list`.

Fichiers web : `lib/skill-library.ts` (hooks, sur le modèle de `lib/mcp.ts`),
`components/skills/*`, routes dans `App.tsx`, libellés dans `lib/i18n/catalog-fr.ts` et
`catalog-en.ts`.

## Lots

### Migration

`0028_skill_library.sql`, derrière la `0027` des images de projet. Les deux sources
préconfigurées y sont insérées à la main, à la fin du fichier généré : une
régénération par `pnpm db:generate` doit les y remettre.

### Lot 1 : bibliothèque et livraison (implémenté)

1. Schéma (`library_skills`, `skill_sources`, graines) et migration.
2. `skillLibrary` dans `AgentConfig`, `[skills] library` dans `config.toml`, `Paths`.
3. `skill-library/layout.ts`, `frontmatter.ts`, `compat.ts`, `store.ts`.
4. `skillRoots` dans `RunnerContext`, branchement des deux runners, `reloadSkillLibrary`.
5. Routes de création, lecture, édition et suppression, sans les fichiers annexes.
6. Suppression des dossiers d'un projet supprimé, skills désactivés compris.

Tests (`apps/server/test/`, `tsx --test`) :

- `skill-library.test.ts` : disposition, unicité global/projet, dossier étranger,
  renommage, désactivation, changement de portée, refus sans écriture partielle,
  problèmes lus sur le disque, empreinte, suppression d'un projet, liens symboliques,
  frontmatter, compatibilité, options Claude, droits des routes ;
- `codex-runner.test.ts` : `extraRoots/set` part avant `thread/start`, se rejoue au
  rechargement et quand l'interrupteur change, et ne part pas quand la bibliothèque
  est coupée.

Recette, sur un serveur jetable avec de vraies sessions Claude (Haiku 4.5) et Codex.
Treize vérifications sur treize :

- un skill de projet créé par l'API apparaît dans la session Claude ouverte en une
  seconde (`projet:e2e-probe`, alias `/e2e-probe`), et dans la session Codex ouverte ;
- un skill global apparaît dans les deux ;
- `/e2e-probe` et `$e2e-probe` s'exécutent, et Claude déclenche le skill global par sa
  description ;
- l'écriture dans la bibliothèque est refusée en `acceptEdits`, après un réglage changé
  à chaud ;
- Codex lit la version modifiée d'un skill ;
- un skill supprimé disparaît des deux inventaires ;
- couper l'interrupteur retire la bibliothèque, à chaud chez Codex, par relance chez
  Claude.

La même écriture est aussi refusée en `bypassPermissions`.

### Lot 2 : interface de gestion (implémenté)

Ce qui a été fait, et ce qui diffère du découpage ci-dessous :

- serveur : fichiers annexes (lecture, écriture, envoi, suppression), export et import
  d'archives, reprise des skills de la machine, duplication. Un dossier choisi dans le
  navigateur est zippé côté client (`fflate`) : un seul chemin d'import. La reprise ne
  copie qu'un chemin que le scan vient de proposer à l'appelant, et un skill de dépôt se
  reprend dans son projet ;
- interface : section des réglages, section du projet, éditeur, menu d'ajout (nouveau,
  archive, dossier, depuis cette machine), interrupteur par conversation, libellés fr et
  en, codes d'erreur traduits ;
- tests : `skill-library-import.test.ts` (archives et évasion par `..`, fichiers annexes,
  export puis import, duplication, scan et reprise avec leurs droits) ;
- parcours dans Chromium sur un serveur jetable : création, fichier annexe, Ctrl+S, page
  projet, reprise d'un skill de dépôt, réglage dans le composer des deux CLI, export,
  duplication, déplacement, désactivation, suppression, affichage au doigt. Aucune
  erreur dans la console.

Découpage prévu :

1. Routes des fichiers annexes, import et export d'archives, `local-scan` et adoption.
2. Section Réglages, section projet, éditeur, fichiers, compatibilité.
3. Interrupteur par conversation dans `agent-settings.tsx`.
4. Libellés fr/en.

Tests : `skill-archive.test.ts` (chemins hors archive refusés, dossier unique de premier
niveau, plafonds). Vérification visuelle avec Playwright sur un serveur jetable, pas sur
le daemon.

Recette : créer, éditer, ajouter un script, renommer, déplacer vers un projet, exporter,
réimporter, supprimer. Le tout depuis l'interface, et visible dans une session ouverte à
chaque étape.

### Lot 3 : sources (implémenté)

Ce qui a été fait, et ce qui diffère du découpage ci-dessous :

- `source_hash` rejoint `library_skills` : une mise à jour se détecte en comparant le
  catalogue à la version de la source installée, et non au contenu écrit. Sans elle, un
  skill renommé à l'installation (frontmatter réécrit) aurait une mise à jour fantôme.
  La migration a été régénérée plutôt que doublée, la branche n'étant alors fusionnée
  nulle part ;
- clones de profondeur 1 sous `$XDG_CACHE_HOME/sillage/<empreinte du dossier de
  données>/skill-sources` : deux instances sur une machine (un serveur de test à côté du
  daemon) ont les mêmes identifiants de sources préconfigurées et ne doivent pas
  rafraîchir le même clone ;
- le clone se fait avec les identifiants git de l'admin qui rafraîchit, par
  l'environnement et sans rien écrire dans le dépôt cloné ;
- un dépôt peut être lui-même un skill (chemin vide) ; `.git` n'est jamais copié ;
- la mise à jour garde le nom de la bibliothèque, remplace le dossier d'un geste, et son
  diff se calcule par `git diff --no-index` entre l'installé et la source, chemins
  ramenés au skill ;
- la recherche skills.sh est réservée aux admins, seuls à pouvoir ajouter la source
  qu'un résultat désigne ; parcourir un catalogue et installer dans ses projets est
  ouvert à tous ;
- l'éditeur se remonte quand le texte change côté serveur sans brouillon en cours
  (`use-editor-revision.ts`) : après une mise à jour appliquée, il montrait l'ancienne
  version, qu'un Ctrl+S aurait réécrite par-dessus la nouvelle. Trouvé par la recette.

Vérifié : `skill-sources.test.ts` sur des dépôts git locaux (catalogue, aperçu,
installation et droits, mise à jour signalée puis appliquée, renommage, modification
locale écrasée, dépôt-skill, échec de récupération, changement de dossier). Dans le
navigateur, contre GitHub : anthropics/skills (19 skills) et openai/skills (39)
récupérées, `pdf` relu puis installé, mise à jour simulée en base, revue en diff avec
l'avertissement d'écrasement puis appliquée, recherche skills.sh (20 résultats),
catalogue au doigt. Non vérifié : un dépôt privé réel, faute d'en avoir un sous la main ;
le chemin des identifiants est celui du clone de projet, déjà en service.

Découpage prévu :

1. `sources.ts` : clone, rafraîchissement, catalogue, installation avec provenance,
   détection des mises à jour, diff, application.
2. `skills-sh.ts` et la route de recherche.
3. Section Sources, dialogue de catalogue, dialogue de mise à jour.

Tests : `skill-sources.test.ts` sur un dépôt git créé dans un dossier temporaire. On
couvre l'installation, puis un commit dans la source qui fait apparaître « mise à jour
disponible », une modification locale qui fait apparaître « modifié localement », et
l'application de la mise à jour.

Recette : installer `pdf` depuis `anthropics/skills` et l'invoquer dans Claude et dans
Codex. Installer un skill d'un dépôt privé avec les identifiants git d'un admin.

### Plus tard

- Pont des skills de dépôt entre CLI : passer `.claude/skills` à Codex en racine
  supplémentaire et `.agents/skills` à Claude. Demande une sonde côté Claude, faute de
  manifeste de plugin dans `.agents/`.
- Bibliothèque versionnée en git, pour l'historique, l'annulation et le partage d'une
  bibliothèque d'équipe par un dépôt commun.
- Création assistée par un agent, dans une conversation ouverte sur le dossier du skill.
- Dépendances MCP déclarées par un skill, activées depuis le registre.
- Portée personnelle, par compte.

## Limites assumées

- **Pas de masquage d'un skill global dans un seul projet.** Les deux CLI lisent une
  racine entière. Exclure un skill pour un projet demanderait une vue générée par
  projet, ou le filtre `skills` du SDK, qui masquerait aussi les skills personnels.
- **Hors de Sillage, les skills de la bibliothèque n'existent pas** : une conversation
  reprise dans le CLI natif ne les a pas, comme pour les serveurs MCP.
- **La protection en écriture n'est qu'un garde-fou** : les règles `deny` arrêtent
  `Edit` et `Write`, pas une redirection Bash.
- **Un skill tiers est du contenu exécuté.** Ses instructions entrent dans le contexte
  et ses scripts tournent avec les droits de l'agent. D'où l'installation réservée aux
  admins, l'aperçu complet avant installation, la copie figée et l'absence de mise à
  jour automatique.

## Documentation

Le modèle de données a rejoint la section 4 de `SPEC.md`, et l'écran la section 12.8.
Ce fichier reste la référence des sondes et des raisons de conception : à relire avant
de toucher à la livraison, et à rejouer (`/tmp/skill-probe`) quand une version de CLI
change le comportement d'un des points relevés.
