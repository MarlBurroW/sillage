# Intégration Codex

Sillage utilise `codex app-server` sur stdio. Les bindings sont générés avec
**codex-cli 0.163.0**. La référence générale est la
[documentation officielle App Server](https://learn.chatgpt.com/docs/app-server).
Les champs récents, notamment `agentMessage.questions`, sont vérifiés dans les types
générés par le binaire installé.

## Questions

- `item/tool/requestUserInput` ouvre un formulaire et reçoit une réponse RPC avec
  l'identifiant natif exact, numérique ou chaîne. `isBlocking` détermine le statut ;
  son absence conserve le comportement des anciens CLI.
- `agentMessage.questions` ouvre un formulaire **non bloquant**. L'agent peut
  continuer, et la question reste répondable après une fin de tour normale. La
  réponse passe par `turn/start`, qui peut aussi injecter dans un tour actif.
  La résolution n'est journalisée qu'après l'accusé de réception du CLI.
- Aucun choix n'est envoyé automatiquement. `serverRequest/resolved` expire
  uniquement la demande correspondante ; plusieurs formulaires peuvent coexister.
- Les questions des sous-agents sont transmises à leur thread. Après arrêt du
  daemon, les formulaires restés ouverts sont expirés, même sur une conversation
  déjà au repos.

Les questions structurées sont activées aussi en mode Default par une surcharge
**du thread** (`features.default_mode_request_user_input`). Une courte instruction
indique au modèle comment utiliser les formulaires. Une liste de choix écrite
uniquement en prose ne suffit pas à créer un formulaire.

## Activités

Les messages, plans proposés, étapes de travail, commandes, modifications de fichiers,
outils MCP et dynamiques, recherches web et leurs résultats, images, attentes,
revues, hooks et compactions ont un rendu. Les sorties d'outils et les changements
de patch se mettent à jour pendant l'exécution. Les diffs successifs remplacent
le récapitulatif du tour.

Les sous-agents ont leur propre activité et leur fil, sans que leur fin de tour
clôture celui du parent. Les avertissements, changements de modèle, nouvelles
tentatives et vérifications automatiques sont visibles. Les jetons sont comptés
par tour, avec le cache, à partir des compteurs natifs.

`notification-policy.ts` classe chaque notification connue : traduction, détail
générique ou doublon volontairement ignoré. Un événement nouveau est conservé dans
le journal et consultable dans le fil ; ses mises à jour remplacent le même repère
visuel. Les items ont un repli générique et un contrôle d'exhaustivité TypeScript.
Une requête serveur non implémentée produit un avertissement et une erreur RPC
explicite. Afficher un outil dynamique ne fournit pas son exécution côté client.

## Compatibilité 0.163.0

`thread/readState/changed` est ignorée : l'état lu/non lu natif ne pilote pas celui
de Sillage. Les méthodes de lecture d'items et de mise à jour de cet état ne sont
pas utilisées. Les outils concurrents restent suivis par identifiant, même quand
leurs sorties s'entrecroisent et qu'ils se terminent dans l'ordre inverse.

Le 17 octobre 2026, le binaire 0.163.0 a été sondé avec un compte connecté :
questions asynchrones et bloquantes, réponses et comptage des jetons passent par
le vrai runner.
`model/list` renvoie `gpt-6.1-sol` par défaut ; le catalogue reste lu dynamiquement.
Les bindings sont vérifiés contre ce même binaire, isolé du CLI de production.

## Steer pendant la réponse

Depuis 0.162.1, `instant_interrupt` est actif par défaut : `turn/steer` coupe la
réponse en cours. Sondé le 17 octobre 2026 sur 0.163.0 (`gpt-6-astra`), steer envoyé
au milieu des `item/agentMessage/delta` :

1. `turn/steer` répond `{ turnId }`, le même tour ; quelques deltas de la réponse
   coupée arrivent encore après l'accusé.
2. Cette réponse n'a **jamais** d'`item/completed`, et `thread/read` ne la garde pas.
3. Écho `userMessage` du steer (`item/started` puis `item/completed`), nouvelle
   réponse `agentMessage` complète, puis un seul `turn/completed` au statut `completed`.

Le runner ignore l'écho, puisque le message est journalisé par `steer`, donc il
apparaît une seule fois. Il clôt la réponse coupée avec le texte déjà reçu en flux,
à l'arrivée de l'écho ou, à défaut, avant `turn.completed`. Sans cela, elle
n'existerait dans le journal que sous forme de deltas, absente de la recherche, du
transfert vers un autre CLI et de `read_conversation`. Un `item/completed` tardif pour
le même item serait ignoré. La séquence est rejouée dans `test/codex-runner.test.ts` ;
la sonde manuelle `pnpm --filter @sillage/server codex:steer-probe` la relève sur le
vrai CLI (`--raw` pour la séquence app-server brute, sans Sillage).

## Fork

Le fork passe par `thread/fork { lastTurnId, excludeTurns }` : le dernier tour conservé,
inclus, dont l'identifiant natif se relit dans le `turn/completed` gardé en `raw` de
l'événement `turn.completed`. `thread/rollback` n'existe plus depuis 0.156.0. Un fork à
la fin du fil n'indique aucun tour ; un fork avant le premier tour terminé est refusé,
la branche n'aurait rien à reprendre.

## Vérification et mise à jour

```sh
pnpm codex:types:check # compare les bindings au binaire installé
pnpm test             # transport RPC, runner, questions et rejeu du journal
pnpm test:codex-ui     # vrais composants, API simulée, ordinateur et mobile
pnpm typecheck
pnpm build
```

La sonde manuelle `pnpm --filter @sillage/server codex:probe` utilise un vrai compte
Codex pour poser une question, y répondre et vérifier la confirmation du modèle.
Elle consomme un court tour, n'est pas exécutée en CI, et accepte `CODEX_BIN` et
`CODEX_MODEL` pour choisir le binaire et le modèle. Ajouter `--blocking` vérifie
également les questions bloquantes en mode Plan. En mode Default, le CLI peut
aussi annoncer `request_user_input` comme non bloquant : le champ `isBlocking`
fait foi, pas le nom de l'outil.

Pour mettre à jour le protocole : lancer `pnpm codex:types`, relire les changements,
compléter les traductions signalées par TypeScript et aligner la version du CLI
dans `.github/workflows/ci.yml`. Codex n'est pas nécessaire pour construire une
release à partir des bindings committés.
