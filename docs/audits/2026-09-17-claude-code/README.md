# Couverture des fonctionnalités Claude Code — 17 septembre 2026

Revue de ce que Sillage expose du CLI Claude Code, comparé à ce que le CLI et le SDK
offrent aujourd'hui. Sur le commit `74e3391`, arbre de travail non commité compris.

**Diagnostic.** Le socle est complet : tout ce qui fait une conversation (modèle,
effort, permissions, plan, questions, MCP, sous-agents, tâches de fond, boucles,
compaction, steer, fork, import) est couvert et à jour. Ce qui manque tient en trois
familles : quelques **réglages de session** apparus depuis (mode Fast, style de sortie,
advisor), une dizaine de **signaux que le CLI émet et que Sillage avale** (notifications,
tentatives de reconnexion à l'API, refus du modèle, refus automatiques de permission),
et deux fonctions plus lourdes qu'on peut couvrir ou non (rewind des fichiers, dialogues
utilisateur). Aucun manque n'est bloquant ; le plus visible est le mode Fast, et le plus
rentable est le relais des signaux, qui explique des silences aujourd'hui inexplicables.

**Périmètre et méthode.** Lecture de l'adaptateur (`apps/server/src/agents/claude/`),
du schéma `ClaudeConfig` et du composer. Comparaison avec les types du SDK installé
(0.3.220) et du dernier publié (0.3.273), et avec le changelog du CLI de 2.1.224 à
2.1.273. Trois sondes sur le CLI installé (2.1.263), par requêtes de contrôle sans
message envoyé au modèle, donc sans tokens : état du mode Fast, bascule à chaud du mode
Fast et du style de sortie, liste des sous-agents. Une lecture de la base de l'instance
pour compter les `session.started` par tour. Aucun code applicatif modifié.

## Versions

| | Installé sur ce poste | Dernier publié | Cible déclarée (`cli-versions.ts`) |
|---|---|---|---|
| CLI `@anthropic-ai/claude-code` | 2.1.263 | 2.1.273 | 2.1.220 |
| SDK `@anthropic-ai/claude-agent-sdk` | 0.3.220 | 0.3.273 | — |

Le diff des types entre les deux SDK fait 2 700 lignes. Rien de ce sur quoi Sillage
s'appuie n'a bougé : `priority` sur les messages (steer), `session_crons` dans le hook
Stop (boucles), `forwardSubagentText`, `usage_EXPERIMENTAL…`, `supportsFastMode`. Deux
requêtes de contrôle disparaissent, `get_plan` et `get_workspace_diff`, que Sillage
n'utilise pas. Le bump est donc sans risque connu, et il apporte des choses utiles
listées plus bas (hooks `PreModelSwitch`/`PostModelSwitch`, `context_usage` et
`usage_report` sur `result`, `capabilities` et `effort` effectif sur `init`,
`permissionPrompts: 'none'`, `reloadOutputStyles()`).

Correctifs du CLI entre 2.1.263 et 2.1.273 qui touchent directement Sillage :

- 2.1.265 : plus de tour parasite « Continue from where you left off. » à la reprise
  d'une session après `/compact` ou une autre commande locale. C'est le chemin que
  Sillage prend quand un réglage impose un redémarrage.
- 2.1.265 : un `cd` dans Bash persiste d'un tour à l'autre en session SDK.
- 2.1.269 : les sessions headless ne se déclarent plus « en attente » pendant qu'un
  sous-agent de fond tourne encore.
- 2.1.273 : le flux SDK ne perd plus les derniers messages d'un sous-agent passé en
  arrière-plan en cours de route.

## Ce qui est couvert

Vérifié dans le runner, l'adaptateur et le composer. Rien à faire ici.

| Domaine | Couverture |
|---|---|
| Réglages | modèle (catalogue lu au CLI), effort `low`…`max` par modèle, six modes de permission, dossiers additionnels, serveurs MCP du registre + serveur Sillage + isolation stricte ; tout est appliqué à chaud sauf `strictMcp` et l'entrée/sortie de `bypassPermissions`, qui relancent en reprise |
| Interactions | permissions avec les règles proposées par le CLI (`once` / session / toujours), questions à choix (`AskUserQuestion`), validation de plan avec choix du mode de suite, élicitation MCP (formulaire et URL) |
| Flux | texte et réflexion en delta, compteur de réflexion, appels et résultats d'outils, sous-agents avec leur fil complet, `file.edited` pour `Write`/`Edit`/`NotebookEdit` |
| Tour | steer par `priority: 'next'`, interruption avec filet de fermeture, compaction manuelle et automatique (début, frontière, échec), erreurs de tour, quota épuisé |
| Fond | tâches de fond et leur arrêt, tâches de sous-agents (début, progression, fin), boucles `/loop` et `CronCreate` par le hook Stop |
| Compte | fenêtres de quota (`/usage`), rate limits en direct, occupation du contexte après chaque tour, coût et tokens par tour, cache compris |
| Session | reprise par id natif, fork à un point du fil, import des sessions du CLI et resynchronisation, titre dérivé par le CLI, commandes `/` du projet avant le premier tour, mentions `@fichier`, images en ligne |

## Ce qui manque

Classé par ce que ça coûte de ne pas l'avoir, pas par ce que ça coûte de le faire.

### A. Signaux du CLI que Sillage ignore

Le `switch` du runner a un `default` qui jette ce qu'il ne connaît pas. C'est
volontaire et documenté, mais la liste de ce qui tombe dedans a grandi. Tout ce qui
suit a une forme stable dans le SDK installé et pourrait alimenter `agent.notice` ou
`error`, déjà dans le schéma, sans nouveau type d'événement.

| Message natif | Ce que l'utilisateur perd aujourd'hui |
|---|---|
| `system/notification` | Les avis du CLI : « Fast mode disabled · usage credits exhausted » (un par tour), « serveur MCP déconnecté, reconnexion abandonnée » (2.1.273), « un serveur MCP demande une authentification ». Ils partent dans le vide. |
| `system/api_retry` | Tentative n/max, délai, statut HTTP. Une API surchargée qui retente pendant deux minutes ressemble à un tour figé. |
| `system/model_refusal_fallback`, `model_refusal_no_fallback` | Le modèle a refusé et le CLI a basculé (ou non) : catégorie, modèle de repli, messages rétractés. Sillage ne dit rien, le fil s'arrête ou repart sans explication. |
| `system/permission_denied` | Refus automatique par le classifieur du mode `auto`, par `dontAsk` ou par une règle, avec la raison. Il ne reste qu'un résultat d'outil en erreur. |
| `system/informational` | Messages de hooks et avis de niveau `notice` / `suggestion` / `warning`, dont un Stop hook qui a bloqué la suite. |
| `tool_use_summary` | Résumé d'un lot d'outils rédigé par le CLI. Tout indiqué pour l'en-tête d'un groupe replié sur mobile. |
| `prompt_suggestion` (sur option `promptSuggestions`) | Prochain message probable, un par tour, presque gratuit (cache du parent). Un bouton « suggéré » sur téléphone. |
| `conversation_reset` | `/clear` est caché de la palette mais reste tapable : le CLI change de conversation et le journal ne l'apprend pas. |
| `tool_progress`, `task_updated`, `memory_recall`, `auth_status` | Durée par outil et tentatives de sous-agents ; patch d'état d'une tâche (pause, arrière-plan) ; mémoires automatiques rappelées ; authentification en cours. Secondaires. |

Un cas à vérifier plutôt qu'à affirmer : un message `user` dont le contenu est une
liste de blocs sans `tool_result` est ignoré par le runner. C'est la forme probable
des messages venus d'une autre session (`SendMessage` entre sessions de la même
machine, ce que Sillage héberge justement) et des canaux MCP. S'ils passent par là,
ils n'apparaissent pas au journal.

### B. Réglages de session que le CLI a et que Sillage n'offre pas

**Mode Fast.** Même modèle, réponses jusqu'à 2,5× plus rapides, tarif $10/$50 par
MTok, sur Opus 5 et Opus 4.8 seulement. Sur un abonnement, c'est facturé en crédits
d'usage, hors quota du forfait. Le premier tour en Fast repaie le contexte entier au
tarif Fast, une fois par conversation : c'est un réglage à poser au départ plutôt
qu'à bascule. En cas de rate limit Fast, le CLI retombe seul en vitesse normale
(état `cooldown`) puis réactive.

Ce que la sonde a mesuré sur ce poste, compte Claude Max :

| Étape | Résultat |
|---|---|
| `initializationResult()` au lancement | `fast_mode_state: off`, `fast_mode_disabled_reason: sdk_opt_in_required` |
| `applyFlagSettings({ fastMode: true })` puis `reinitialize()` | `fast_mode_state: on`, sans relancer le CLI |
| `applyFlagSettings({ fastMode: null })` | retour à `off` |
| modèles avec `supportsFastMode` | `default` (Opus) et `opus[1m]` ; ni Fable, ni Sonnet, ni Haiku |

Donc : c'est le SDK qui doit opter, un `/fast` tapé dans Sillage répond « non
disponible » (la commande est déjà cachée de la palette pour une autre raison) ; la
bascule se fait à chaud par la même requête que l'effort ; l'état est lisible sur
`init` et sur chaque `result` (`fast_mode_state`, dont le `cooldown`). Ce que la
sonde ne dit pas : si l'API accepte réellement la requête Fast pour ce compte
(crédits d'usage activés ou non). Ça ne se voit qu'au premier tour, et l'échec arrive
par le `system/notification` de la section A. Activer Fast sur un modèle qui ne le
gère pas fait basculer le CLI sur Opus ; le hook `PostModelSwitch` du SDK 0.3.273
permettrait de le voir.

Forme naturelle : un booléen `fastMode` dans `ClaudeConfig`, proposé seulement quand
le modèle choisi a `supportsFastMode` (à remonter dans `AgentModelDto`), passé au
lancement et à chaud par `applyFlagSettings`, avec l'état (`on` / `cooldown`) et une
mention du coût dans la rangée de signaux du composer.

**Style de sortie.** Cinq styles sur ce poste : `default`, `Proactive`, `Concise`,
`Explanatory`, `Learning`. `Concise` est celui que le CLI a ajouté en 2.1.236 : résultats
d'abord, sans préambule. Sondé : `applyFlagSettings({ outputStyle: 'Concise' })` change
`output_style` à chaud, `null` revient au défaut. La liste vient de
`initializationResult().available_output_styles`. Réglage simple, dans la lignée de
l'effort.

**Advisor.** `/advisor <modèle>` et la clé `advisorModel` : un modèle plus fort que le
modèle principal consulte à la demande. Disponible en headless depuis 2.1.260. Coût
supplémentaire par consultation. À exposer comme option, pas comme défaut.

**Garde-fous de budget.** `maxTurns`, `maxBudgetUsd` (le tour se ferme en
`error_max_budget_usd`), `taskBudget` en alpha. Rien de tout ça n'est exposé. C'est
surtout pertinent pour l'API de tâches `/api/v1`, où une machine ouvre des tâches
sans les regarder.

**Sous-agents nommés.** `supportedAgents()` en liste cinq ici (`claude`, `Explore`,
`general-purpose`, `Plan`, `statusline-setup`), plus ceux du projet sous
`.claude/agents/`. Le CLI accepte `@agent` dans le texte et le propose à la frappe ;
Sillage ne les connaît pas. Même mécanique que les commandes `/`.

**Réflexion.** Option `thinking` (adaptative, budget fixe, coupée) et
`setMaxThinkingTokens`. Sur les modèles récents la réflexion est adaptative et pilotée
par l'effort, déjà exposé : redondant pour l'usage courant.

**Bac à sable, outils, repli.** `sandbox` (bubblewrap sur Linux), `tools` /
`allowedTools` / `disallowedTools`, `fallbackModel`, `planModeInstructions`. Le bac à
sable et les règles d'outils viennent des `settings.json` du poste, que le SDK charge
par défaut (`settingSources` omis = tout) : ils s'appliquent donc déjà, sans réglage
par conversation. Codex a un sélecteur de bac à sable dans Sillage, Claude non ; c'est
une asymétrie acceptable tant que personne ne la demande.

### C. Deux fonctions plus lourdes, à trancher

**Rewind des fichiers.** `/rewind` dans le CLI : `enableFileCheckpointing` au lancement,
puis `rewindFiles(userMessageId)` ramène les fichiers à leur état au message choisi.
Sillage sait forker une conversation à un point du fil mais pas remettre le disque
dans l'état de ce point. C'est la fonction la plus demandée du CLI qui manque ; elle
touche le journal (il faut l'`uuid` du message utilisateur), le panneau de fichiers
et les worktrees.

**Dialogues utilisateur.** `onUserDialog` + `supportedDialogKinds` : des dialogues
bloquants que le CLI demande à l'hôte de rendre (`request_user_dialog`), par exemple
la proposition de repli après un refus du modèle. Sans rappel, le CLI applique le
défaut de chaque dialogue. L'ensemble des `dialogKind` est ouvert et n'est pas
énuméré dans les types : à relever par sonde avant de câbler quoi que ce soit.

### D. Hors de portée, ou déjà écarté

Remote Control (écarté après mesure, SPEC §11), Teleport, sessions cloud et
self-hosted runner, tout ce qui est propre au terminal (mode plein écran, panneau
`/diff`, `/focus`, `/recap`, correcteur, raccourcis, thèmes), `claude agents`, la
dictée du CLI (Sillage a la sienne), `/desktop`, `/ide`. Les plugins et les
compétences s'installent sur le disque du CLI et sont chargés par défaut : Sillage
les subit correctement sans UI dédiée, et pourrait au plus offrir un « recharger »
(`reloadPlugins()`, `reloadSkills()`). Ultracode, Workflow et Monitor sont des outils
du modèle, visibles par les tâches de fond : rien à faire.

## Relevé en passant

- **`init` arrive à chaque tour**, pas seulement au lancement. Compté en base sur
  une conversation récente : 13 `session.started` et 13 `commands.updated` pour
  13 tours. Le runner réémet donc `session.started` et refait une requête
  `supportedCommands()` à chaque tour. Pas un bug, mais du bruit au journal et une
  requête de contrôle inutile par tour. N'émettre qu'au changement de `session_id`
  ou de `model` suffirait, et le `model` porté par ces `init` est justement ce qui
  rend visible un changement de modèle décidé par le CLI.
- **`file.edited` ne voit que les outils de fichiers.** Le réglage
  `bashEditDiffEnabled` (2.1.269) joint au résultat de `Bash` le diff des fichiers
  que la commande a modifiés, ce qui couvrirait le `sed -i` et le `rm` que la SPEC
  signale comme angles morts.
- **La cible `PREFERRED_CLI_RELEASES.claude` est à 2.1.220**, deux mois derrière le
  poste. Le caret ne hurle pas, mais à bumper avec le SDK.

## Recommandation, dans l'ordre

| Priorité | Chantier | Bénéfice | Ampleur |
|---|---|---|---|
| P1 | Bump SDK 0.3.273 et cible CLI 2.1.273 | Prérequis des hooks de changement de modèle et de `context_usage` sur `result` ; aucun type utilisé ne casse | Petite |
| P1 | Relayer `notification`, `api_retry`, `model_refusal_*`, `permission_denied`, `informational` sur `agent.notice` / `error` | Les silences deviennent des phrases ; c'est aussi ce qui dira « Fast coupé, crédits épuisés » | Petite |
| P1 | Mode Fast par conversation, à chaud, visible seulement sur les modèles qui le gèrent, état et coût affichés | La nouveauté la plus visible du CLI, sondée et bascule vérifiée | Moyenne |
| P2 | Style de sortie | Réglage à chaud vérifié, cinq styles, `Concise` en tête | Petite |
| P2 | `prompt_suggestion` en option | Un tap pour le message suivant sur téléphone | Petite |
| P2 | `session.started` seulement au changement | Journal plus léger, une requête de contrôle de moins par tour | Petite |
| P3 | Sous-agents `@` à la frappe, garde-fous de budget pour `/api/v1`, advisor | Parité de saisie, sécurité des tâches machine | Petite à moyenne |
| P3 | Rewind des fichiers, dialogues utilisateur | Fonctions entières, à sonder avant de décider | Importante |

Les ampleurs sont des estimations de périmètre, pas des engagements de délai.

## Suite donnée, le même jour

Tout ce qui précède est fait, sauf le rewind des fichiers, écarté par l'utilisateur,
et les dialogues utilisateur, dont les sortes ne sont pas énumérables sans sonde.

- SDK 0.3.273 et cible CLI 2.1.273. Rien de ce que Sillage utilise n'a bougé.
- Les signaux du CLI sont traduits en `agent.notice` dans `signals.ts`, module pur et
  testé : notifications, tentatives d'API, refus du modèle, refus automatiques,
  messages de hooks, remise à zéro de conversation.
- Mode rapide, style de réponse et conseiller sont des réglages de conversation,
  appliqués au lancement par `settings` et à chaud par `applyFlagSettings`. Le mode
  rapide n'est proposé que sur les modèles qui le gèrent et si le compte y a droit ;
  son état revient dans le fil, en un seul avis qui se remplace.
- `maxBudgetUsd` et `maxTurns` sont des champs de configuration, surchargeables par
  l'API de tâches, sans réglage dans le composer.
- Les suggestions de message suivant sont demandées au CLI et proposées sous le fil,
  un tap les pose dans la saisie. `promptSuggestionEnabled: false` dans les réglages
  du poste les coupe.
- `session.started` n'est plus journalisé qu'au changement de session ou de modèle,
  et les commandes ne sont demandées qu'au premier init.
- Les sous-agents nommés arrivent dans le catalogue (`agents`), sans proposition à la
  frappe pour l'instant : le composer était en cours de refonte par une autre session.

Vérifié de bout en bout par `pnpm --filter @sillage/server claude:probe`, trois tours
minuscules sur le CLI 2.1.263 avec le SDK 0.3.273 : un seul `session.started` pour
trois tours, le style `Concise` accepté au lancement, la bascule à chaud
`applyConfig({ fastMode: true })` acceptée, l'avis « Mode rapide activé » au tour
suivant, puis la suggestion de message après le `result`. Sur ce compte, l'API a
refusé la requête rapide faute de crédits d'usage : le CLI l'a redit dans une
`notification` (« Fast mode disabled · usage credits exhausted »), relayée dans le fil,
et le tour s'est fait à vitesse normale. C'est le comportement documenté, et la raison
pour laquelle le réglage est proposé même quand la première requête peut échouer :
Sillage ne peut pas le savoir avant, la vérification de disponibilité passe.

## Sondes

Scripts jetables, lancés depuis `apps/server` avec le SDK installé et le binaire
résolu par `readlink -f "$(which claude)"`. Ils ouvrent une session avec une file
d'entrée vide, posent leurs requêtes de contrôle et ferment : aucun message au modèle.

```js
// Mode Fast : état au lancement, bascule à chaud, modèles compatibles.
const init = await q.initializationResult()
init.fast_mode_state              // 'off'
init.fast_mode_disabled_reason    // 'sdk_opt_in_required'
init.models.map((m) => [m.value, m.supportsFastMode])
await q.applyFlagSettings({ fastMode: true })
;(await q.reinitialize()).fast_mode_state   // 'on'

// Style de sortie : même mécanique.
init.available_output_styles      // ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']
await q.applyFlagSettings({ outputStyle: 'Concise' })
;(await q.reinitialize()).output_style      // 'Concise'
```

À rejouer au prochain bump du SDK : rien de tout ça n'est documenté au-delà des
types, et `applyFlagSettings` est annoncé « streaming input only ».

## Complément du 6 octobre 2026 : cible 2.1.291

Relecture du changelog de 2.1.274 à 2.1.291 (≈ 1 500 lignes, surtout des correctifs) et
du diff des types entre le SDK 0.3.273 et 0.3.291, avec des sondes par requêtes de
contrôle sur le CLI du poste (2.1.286) et sur un 2.1.291 téléchargé à part, sans
toucher au binaire du système.

| | Installé sur ce poste | Dernier publié | Cible déclarée |
|---|---|---|---|
| CLI `@anthropic-ai/claude-code` | 2.1.286 | 2.1.291 (`stable` : 2.1.285, `next` : 2.1.292) | 2.1.273 → **2.1.291** |
| SDK `@anthropic-ai/claude-agent-sdk` | 0.3.273 | 0.3.291 | 0.3.273 → **0.3.291** |

Rien de ce que Sillage utilise n'a bougé dans le SDK : le typecheck passe sans
retouche. Les outils `TaskOutput` (retiré en 2.1.276) et `REPL` sortent des schémas
d'outils ; Sillage ne les traitait pas à part.

### Ce qui touchait Sillage, et ce qui a été fait

- **Ultracode n'est plus un niveau d'effort (2.1.284).** Il n'impose plus `xhigh` et
  tient à tout niveau ; en revanche un `effortLevel` qui change le niveau sans la clé
  `ultracode` l'éteint. Sillage envoyait l'effort seul : changer l'effort d'une
  conversation en Ultracode l'éteignait côté CLI pendant que le composer l'affichait
  allumé. Sondé sur 2.1.286 et 2.1.291 par `getSettings().applied` (méthode présente à
  l'exécution, absente du type public). Corrigé : `liveFlagSettings` renvoie
  `ultracode: true` avec tout changement d'effort, et le composer n'aligne plus
  l'effort sur `xhigh` quand on l'allume. Le CLI le refuse toujours aux modèles sans
  `xhigh` (`ultracodeAvailable: false` sur Haiku 4.5 et Sonnet 4.6) : le réglage reste
  réservé à ceux-là.
- **Noms de modèles qui sortent du catalogue.** `opus[1m]` n'est plus listé depuis
  2.1.282 (Opus a d'office un million de tokens), et 2.1.291 liste Fable 5.1 sous
  l'alias `fable` au lieu de `claude-fable-5-1`. Le CLI accepte toujours les anciens
  noms, mais le composer, qui cherchait la valeur exacte, perdait l'effort, la vitesse
  et Ultracode de ces conversations : 94 actives en `opus[1m]` en base, une dizaine en
  `claude-fable-5-1`. `catalogModel` retrouve désormais l'entrée par le nom sans
  `[1m]`, puis par l'identifiant résolu.
- **Deux signaux de plus.** `conversation_reset` porte son `trigger` (`clear`,
  `plan_mode_exit`, `fresh_session`, `onboarding`), traduit en phrase ; l'`init`
  porte `plugin_errors`, relayé en un avis qui ne revient qu'au changement. Sillage
  charge sa bibliothèque de skills comme plugins : un refus y était muet.

### Ce qui touche Sillage sans code

- **Limite des commandes de fond (2.1.285, 2.1.288).** Une commande lancée avec
  `run_in_background` s'arrête au bout de 30 min par défaut, 2 h au plus, dans les
  sessions « non surveillées ». Le CLI range dans cette catégorie toute session SDK
  qui ne se déclare pas Desktop ou VS Code, donc celles de Sillage. À trancher : carte
  #12.
- **AGENTS.md lu par Claude (2.1.277)** : déjà couvert, `claudeMdExcludes` masque les
  deux fichiers en mode SILLAGE.md (sondé le 5 octobre, `docs/sillage-md.md`).
- **Mode de permission par défaut à `auto`** quand la session n'en donne aucun : Sillage
  en passe toujours un.
- **Opus 5.5 et Sonnet 5.5** : le catalogue est lu au CLI, ils sont apparus seuls.
- Correctifs SDK qui profitent directement : un message envoyé en priorité ne coupe
  plus un WebFetch en cours, les heartbeats d'outil arrivent pendant un flux bloqué,
  le repli de modèle ne se répète plus à chaque message après un changement de modèle
  en vol, `set_model` reprend les limites de sortie du nouveau modèle, un tour ne
  reste plus ouvert quand son flux est coupé.

### Laissé de côté, noté

- `get_task_output`, la fin de la sortie d'une commande de fond, sans tour de modèle :
  carte #13. Présente à l'exécution du SDK mais pas dans son type public.
- Consultations de l'advisor (`advisor_tool_result`) que le fil ne rend pas : carte
  #14.
- `prewarm()` / `claim()` (alpha) : un CLI démarré d'avance, lié ensuite à une session.
  Gagnerait le démarrage d'une conversation, mais impose de figer à l'avance tout ce
  que Sillage passe au lancement (MCP, plugins, hooks).
- MCP Apps (`readMcpResource`, `_meta.ui`, alpha) : rendre les widgets HTML des
  serveurs MCP, en bac à sable.
- `mcpServer` sur les demandes de permission (serveur et provenance d'un outil
  `mcp__*`), `verbatimPrompts`, `pasted_content`, `view_mode` de `/focus` : sans usage
  identifié aujourd'hui.

Vérifié : typecheck, tests (dont `claude-flag-settings.test.ts` et les nouveaux cas de
`claude-signals.test.ts`), lint, et un passage Playwright jetable sur le composer réel
(API simulée), grand écran et téléphone : une conversation `opus[1m]` s'affiche « Opus
5.5 » avec son effort, une `claude-fable-5-1` « Fable 5.1 », et Ultracode s'allume sans
toucher à l'effort.
