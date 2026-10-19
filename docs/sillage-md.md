# SILLAGE.md : des consignes communes à Claude, Codex, OpenCode et Grok Build

Des consignes tenues par Sillage et injectées dans le prompt système de chaque session,
quel que soit son CLI : une partie **globale** (administrateurs) et une par **projet**
(propriétaire). Éditables depuis la page du projet, les réglages (`/settings/consignes`)
et l'en-tête d'une conversation, sans passer par l'éditeur de fichiers.

## Où vivent les consignes d'un projet

Chaque projet a un mode, choisi à la création (`instructionsMode`) et modifiable ensuite :

- **`sillage`** : le texte est en base (table `instructions`) et injecté à chaque CLI. Les
  `CLAUDE.md`, `CLAUDE.local.md` et `AGENTS.md` du workspace et du worktree sont masqués
  aux agents, sans être touchés sur le disque : les garder lus doublerait les consignes.
- **`repo`** : la partie projet est le `AGENTS.md` (ou `CLAUDE.md`) du dépôt, que les CLI
  lisent d'eux-mêmes. L'interface édite ce fichier directement, `AGENTS.md` par défaut.
  Sillage n'injecte que la partie globale.

Sans choix à la création, le serveur regarde le dossier : `repo` s'il porte déjà un de
ces fichiers, `sillage` sinon. Les projets d'avant le réglage n'ont pas de mode (null) et
gardent ce comportement résolu à la volée ; la première écriture de contenu Sillage fixe
leur mode à `sillage`, pour qu'un `AGENTS.md` apparu ensuite ne le fasse pas taire.

La migration d'un projet existant n'est proposée que dans son panneau de consignes : un
bouton importe le texte des fichiers du dépôt et bascule en mode `sillage` d'un geste.
Les fichiers restent dans le dépôt ; revenir au mode `repo` les réactive.

## Ce que les sondes ont établi

Sondé le 2026-10-05 sur Claude Code 2.1.286 et codex-cli 0.157.1.

- Claude Code lit `AGENTS.md` à la racine comme `CLAUDE.md`.
- Le réglage `claudeMdExcludes` (flag settings) masque les deux. Les motifs doivent être
  bornés au dossier : `**/CLAUDE.md` sans racine masquerait aussi `~/.claude/CLAUDE.md`.
- Côté Codex, `project_doc_max_bytes = 0` coupe les `AGENTS.md` du projet ; celui de
  `CODEX_HOME` reste lu.

Sondé le 2026-10-05 sur opencode 1.18.25.

- OpenCode lit le `AGENTS.md` du projet, et à défaut son `CLAUDE.md`.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` coupe les deux. C'est le seul interrupteur : il
  coupe aussi l'`opencode.json` et le dossier `.opencode/` du projet. Les consignes
  passent par le champ `system` de chaque message.

Sondé le 2026-10-17 sur Grok Build 1.0.62.

- Grok lit `AGENTS.md`, `Agents.md`, `AGENT.md`, `CLAUDE.md` et `Claude.md` de chaque
  dossier entre la racine du dépôt et le dossier de travail, plus ceux de `~/.grok`, et
  ceux de `~/.claude` tant que `GROK_CLAUDE_AGENTS_ENABLED` n'est pas coupé (Sillage le
  coupe toujours).
- Le seul interrupteur est le profil d'agent : `_meta.agentProfile` avec
  `agentsMd: false` à la création et à la reprise de la session. Il ne retire au prompt
  système que le paragraphe sur la vérification au navigateur.
- Les consignes passent par `_meta.rules` de `session/new`, ajouté au prompt système dans
  un bloc `<human_rules>`. Le champ `systemPrompt` de l'ACP et l'option `--rules` sont
  ignorés par `grok agent`.

## Les agents peuvent y écrire

Le serveur MCP `sillage` traite SILLAGE.md comme un fichier : `read_instructions` le lit,
`edit_instructions` remplace un passage exact (comme l'outil Edit, `old_text` vide pour
ajouter à la fin), `write_instructions` le réécrit entièrement. Partie projet en mode
`sillage` seulement, partie globale en écriture pour une conversation d'administrateur.
Chaque écriture se fait dans une transaction sur la version courante, et l'interface
affiche la dernière main (personne ou session). En mode `repo`, les outils renvoient
l'agent vers le fichier du dépôt, qu'il modifie avec ses propres outils.

## Quand une modification prend effet

Au lancement d'une session pour Claude et Codex. Claude enregistre son prompt système au
premier échange et le rejoue tel quel à la reprise : une session déjà ouverte garde la
version reçue jusqu'à sa prochaine compaction. OpenCode, qui les reçoit avec chaque
message, voit une modification dès le suivant. Grok Build les reçoit à la création de la
session et les garde toute sa vie : une reprise relit le prompt système enregistré. Le mode, lui, est lu au lancement du
runner.

## Donner aux agents des liens accessibles à distance

Si le navigateur est sur un autre appareil, les liens de prévisualisation doivent
utiliser le nom VPN de la machine qui exécute les agents. Le
[guide d’accès distant](remote-access.md#teach-agents-to-share-reachable-preview-links)
fournit un modèle à adapter dans les consignes globales ou celles du projet :
nom réel de la machine, ports autorisés, HTTPS, vérification et nettoyage.
Ces consignes guident les agents ; elles ne configurent pas le VPN elles-mêmes.

## Recette

`apps/server/test/instructions.test.ts` couvre routes, modes, migration et l'outil MCP.
La recette avec de vrais CLI a tourné sur un serveur jetable (`/tmp/smd-e2e`, port 7402) :
9 vérifications sur 9, injection globale et projet, masque en mode `sillage`, mode
`repo` intact, consigne retenue par Claude reçue par la session Codex suivante.

# Mémoire du projet

À côté des consignes, qui sont des règles données aux agents, la mémoire est ce qu'ils
retiennent d'eux-mêmes : un index `MEMORY.md` et une note par fichier, au format de la
mémoire automatique de Claude Code. Un dossier par projet, `<data>/memory/projects/<id>`,
partagé par tous les CLI et par tous les worktrees du projet.

- **Claude** reçoit ce dossier en `autoMemoryDirectory` (flag settings) et s'en sert
  comme de sa mémoire native : il charge l'index au démarrage et écrit ses notes sans
  demander de permission, même en mode par défaut. Rien n'est plus écrit dans
  `~/.claude/projects/<dossier>/memory`.
- **Codex** n'a pas d'équivalent (sa fonction `memories` extrait des souvenirs des fils
  passés, en arrière-plan). Il reçoit l'index et le chemin du dossier dans ses
  instructions développeur, lit les notes par `cat`, et écrit par les outils MCP
  `read_memory`, `write_memory` et `delete_memory`, son bac à sable ne pouvant écrire hors
  du workspace. `write_memory` ajoute seul la ligne d'index d'une note nouvelle.
- **OpenCode** est traité comme Codex : l'index et le chemin du dossier arrivent avec
  chaque message, dans son prompt système, et il écrit par les mêmes outils MCP.
- **Grok Build** aussi, à ceci près que l'index arrive une fois, dans les `rules` de la
  création de session. Sa propre mémoire entre sessions (`~/.grok/memory-v2`) n'est pas
  touchée.
- **Interface** : une carte « Mémoire » sur la page du projet liste les notes, les ouvre
  en édition et les supprime avec leur ligne d'index.
- **Mode natif** (`memoryMode = 'native'`, réglé sur la carte Mémoire) : Sillage ne tient
  plus de dossier pour ce projet. Claude garde sa mémoire habituelle dans `~/.claude`, par
  dossier de travail ; Codex, OpenCode et Grok la leur ; aucun index n'est injecté et les
  outils MCP de mémoire ne sont pas annoncés. Le défaut des projets à venir, comme celui du
  mode des consignes, est un réglage du compte (`projectDefaults`), posé par la visite de
  première ouverture.

Au premier lancement, la mémoire que Claude tenait pour la racine du workspace est
copiée dans le dossier encore vide, une seule fois (trace `.imported-from.json`).
L'original reste en place. Celle des worktrees, que Claude rangeait par dossier, n'est
pas reprise.

Sondé le 2026-10-05 sur Claude Code 2.1.286 : `autoMemoryDirectory` redirige lecture et
écriture, et rien n'est écrit dans le dossier par défaut. Recette avec de vrais CLI :
8 vérifications sur 8, import, écriture par Claude lue par Codex, écriture par Codex
(`write_memory`) lue par Claude.
