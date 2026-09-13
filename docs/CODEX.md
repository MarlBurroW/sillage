# Intégration Codex

Sillage utilise `codex app-server` sur stdio. Les bindings sont générés avec
**codex-cli 0.153.2**. La référence générale est la
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
