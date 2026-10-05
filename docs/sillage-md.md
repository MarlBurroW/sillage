# SILLAGE.md : des consignes communes à Claude et Codex

Des consignes tenues par Sillage et injectées dans le prompt système de chaque session,
Claude comme Codex : une partie **globale** (administrateurs) et une par **projet**
(propriétaire). Éditables depuis la page du projet, les réglages (`/settings/consignes`)
et l'en-tête d'une conversation, sans passer par l'éditeur de fichiers.

## Où vivent les consignes d'un projet

Chaque projet a un mode, choisi à la création (`instructionsMode`) et modifiable ensuite :

- **`sillage`** : le texte est en base (table `instructions`) et injecté aux deux CLI. Les
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

## Les agents peuvent y écrire

Le serveur MCP `sillage` traite SILLAGE.md comme un fichier : `read_instructions` le lit,
`edit_instructions` remplace un passage exact (comme l'outil Edit, `old_text` vide pour
ajouter à la fin), `write_instructions` le réécrit entièrement. Partie projet en mode
`sillage` seulement, partie globale en écriture pour une conversation d'administrateur.
Chaque écriture se fait dans une transaction sur la version courante, et l'interface
affiche la dernière main (personne ou session). En mode `repo`, les outils renvoient
l'agent vers le fichier du dépôt, qu'il modifie avec ses propres outils.

## Quand une modification prend effet

Au lancement d'une session. Claude enregistre son prompt système au premier échange et
le rejoue tel quel à la reprise : une session déjà ouverte garde la version reçue
jusqu'à sa prochaine compaction. Le mode, lui, est lu au lancement du runner.

## Recette

`apps/server/test/instructions.test.ts` couvre routes, modes, migration et l'outil MCP.
La recette avec de vrais CLI a tourné sur un serveur jetable (`/tmp/smd-e2e`, port 7402) :
9 vérifications sur 9, injection globale et projet, masque en mode `sillage`, mode
`repo` intact, consigne retenue par Claude reçue par la session Codex suivante.

# Mémoire du projet

À côté des consignes, qui sont des règles données aux agents, la mémoire est ce qu'ils
retiennent d'eux-mêmes : un index `MEMORY.md` et une note par fichier, au format de la
mémoire automatique de Claude Code. Un dossier par projet, `<data>/memory/projects/<id>`,
partagé par les deux CLI et par tous les worktrees du projet.

- **Claude** reçoit ce dossier en `autoMemoryDirectory` (flag settings) et s'en sert
  comme de sa mémoire native : il charge l'index au démarrage et écrit ses notes sans
  demander de permission, même en mode par défaut. Rien n'est plus écrit dans
  `~/.claude/projects/<dossier>/memory`.
- **Codex** n'a pas d'équivalent (sa fonction `memories` extrait des souvenirs des fils
  passés, en arrière-plan). Il reçoit l'index et le chemin du dossier dans ses
  instructions développeur, lit les notes par `cat`, et écrit par les outils MCP
  `read_memory`, `write_memory` et `delete_memory`, son bac à sable ne pouvant écrire hors
  du workspace. `write_memory` ajoute seul la ligne d'index d'une note nouvelle.
- **Interface** : une carte « Mémoire » sur la page du projet liste les notes, les ouvre
  en édition et les supprime avec leur ligne d'index.

Au premier lancement, la mémoire que Claude tenait pour la racine du workspace est
copiée dans le dossier encore vide, une seule fois (trace `.imported-from.json`).
L'original reste en place. Celle des worktrees, que Claude rangeait par dossier, n'est
pas reprise.

Sondé le 2026-10-05 sur Claude Code 2.1.286 : `autoMemoryDirectory` redirige lecture et
écriture, et rien n'est écrit dans le dossier par défaut. Recette avec de vrais CLI :
8 vérifications sur 8, import, écriture par Claude lue par Codex, écriture par Codex
(`write_memory`) lue par Claude.
