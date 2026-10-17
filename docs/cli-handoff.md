# Continuer une conversation dans un autre CLI

Depuis une conversation, « Continuer dans un autre CLI… » (menu `…` de l'en-tête) ouvre
une conversation neuve menée avec Claude Code, Codex, opencode ou Grok Build, qui reprend le fil
là où il en est. Le modèle à suivre est celui des « portable handoffs » de T3 Code :
pas un résumé écrit par un agent, mais une **sélection budgétée de l'historique**, textes
entiers, dans l'ordre et avec leur rôle.

## Ce que reçoit le nouvel agent

Un bloc injecté dans le canal de consignes du CLI, le même que SILLAGE.md : le prompt
système chez Claude (`systemPrompt.append`), les `developerInstructions` du thread chez
Codex, le `system` de chaque message chez opencode, les `rules` de la création de session
chez Grok Build. Il y reste pour toute la vie de la conversation, comme l'historique d'un
fil ordinaire, et il est relu à chaque démarrage du CLI puisque celui-ci repart sans lui
à chaque reprise (Grok, lui, le garde dans le prompt système enregistré avec la session).

Le bloc contient, dans l'ordre de priorité de la sélection :

1. **la demande d'origine**, premier message de l'utilisateur ;
2. **les derniers échanges**, en remontant depuis la fin sans sauter de message, pour
   que la fenêtre reste un fil lisible ; un tour interrompu y est dit, pour que le
   travail qui précède se lise comme partiel ;
3. **les appels d'outils de cette fenêtre**, les plus récents d'abord, entrée coupée à
   400 caractères et sortie à 1 200.

Ce qui n'entre pas est remplacé par une référence :

```
[14 message(s) omis ici, du message 4 au message 120. Pour les relire :
read_conversation avec id="…" et before=121, puis remonter avec la valeur de
`before` que l'outil annonce.]
```

`read_conversation` est l'outil du serveur MCP de Sillage, qui rend les messages de
l'utilisateur et de l'agent d'une conversation du projet, par tranches. Les numéros
cités sont les `seq` du journal, ceux que l'outil attend.

Le raisonnement, l'état des outils et les pièces jointes ne sont pas transférés. **La
nouvelle demande n'en fait pas partie** : elle s'écrit dans le composer de la suite,
jamais raccourcie, et c'est le premier message du fil.

## Budget

16 k jetons par défaut, entre 1 k et 64 k, choisis dans le dialogue. Le compte est
prudent, **un jeton par octet** : il surestime d'un facteur trois à quatre sur du texte
courant, et le transfert tient quel que soit le tokenizer du modèle cible. La référence
est comptée avant les messages, parce qu'elle est ce qui reste quand rien d'autre ne
tient ; l'en-tête du bloc, lui, est un coût fixe hors budget. Si même la demande
d'origine ne tient pas, le transfert échoue (`handoff_too_large`) plutôt que de partir
tronqué.

## Où ça vit

- `apps/server/src/conversations/handoff.ts` : repli du journal en éléments
  (`collectHandoffItems`), sélection (`selectHandoff`), rendu (`renderHandoff`). Pur et
  testé (`apps/server/test/handoff.test.ts`). La sélection lit le journal normalisé et
  ne sait pas quel CLI a produit le fil.
- `POST /api/conversations/:id/handoff` (`agent`, `config`, `budgetTokens?`) crée la
  suite, dans le même worktree et sur la même carte ; `GET /api/conversations/:id/handoff`
  rend le bloc transmis, que le dialogue « Détails de la session » affiche.
- Table `conversation_handoffs` : le bloc figé à la création, comme un fork fige le
  journal. `conversations.handoff_from_id` porte la filiation, que l'en-tête affiche en
  puce vers la source. Une branche d'une suite hérite de son bloc.
- L'injection se fait dans `session-manager.ts`, en tête des parties de
  `projectOverview`, hors de tout interrupteur : c'est l'historique de ce fil, pas un
  apport de Sillage.

## Ce que les sondes ont établi

Sondé le 2026-10-15 sur codex-cli 0.162.1, Claude Code 2.1.296 et opencode 1.18.34.

- Codex expose `thread/inject_items` (nom en snake_case ; `thread/injectItems` est
  refusé), qui ajoute des items bruts de l'API Responses à l'historique visible du
  modèle. Un message `user` et un `assistant` injectés sont relus par le modèle au tour
  suivant, **et survivent à un `thread/resume` dans un nouvel app-server**. C'est la voie
  que T3 Code emprunte. Sillage ne s'en sert pas encore : le canal de consignes est le
  même pour les trois CLI et se rejoue à chaque démarrage sans question de persistance.
  Passer Codex à `inject_items` demanderait de garder la sélection structurée (rôles)
  et de n'injecter qu'au `thread/start`, jamais au `thread/resume`.
- Transferts réels sur un serveur jetable, projets neufs : Claude → Codex et
  Codex → Claude avec le serveur MCP de Sillage coupé, pour que la seule source soit le
  bloc injecté (Claude cite « le message 74 du fil transféré ») ; Claude → Codex avec
  un message trop long pour un budget de 1 k, où Codex appelle `read_conversation` avec
  l'`id` et le `before` de la référence et retrouve ce qui manquait.
- Piège observé : la mémoire de projet (`memory/`) est partagée entre CLI et peut
  contredire le bloc transmis quand une session antérieure y a écrit autre chose ;
  l'agent a d'abord préféré la mémoire. L'en-tête dit depuis que le fil continué
  l'emporte et qu'une contradiction se signale.
