# Intégration OpenCode

Sillage lance un `opencode serve` par conversation et lui parle en HTTP, avec un flux
SSE (`GET /event`). Les bindings sont générés depuis l'OpenAPI que le binaire publie sur
`GET /doc`, avec **opencode 1.18.25**. Tout ce qui suit a été sondé sur cette version.

## Génération d'API

Deux générations cohabitent dans le serveur d'opencode. L'adaptateur ne parle que la
première (`/session/...`, flux `GET /event`), épinglée dans `rawFormat` sous
`opencode-server@v1` :

- la seconde (`/api/session/...`, `GET /api/event`, événements `session.next.*`) n'a ni
  fork ni gestion des serveurs MCP ;
- son flux ne dit rien des sessions créées par la première : les deux ne se mélangent pas ;
- c'est la première que parlent le TUI et le SDK d'opencode.

## Ce qui se règle au lancement, et ce qui se règle au message

opencode lit ses permissions, ses serveurs MCP et ses dossiers de skills dans sa
configuration. Sillage les injecte par `OPENCODE_CONFIG_CONTENT`, fusionné par-dessus
l'`opencode.json` du poste sans y écrire. En changer relance donc le serveur de la
conversation, qui reprend sa session (elles vivent dans la base d'opencode).

Modèle (`fournisseur/modèle`), variante et agent primaire partent avec chaque message et
se changent à chaud.

| Réglage Sillage | Chez opencode |
|---|---|
| Modifications, commandes, accès web | `permission.edit`, `.bash`, `.webfetch` : `ask`, `allow`, `deny`, ou rien (la règle du poste) |
| Répertoires supplémentaires, pièces jointes, mémoire, skills | `permission.external_directory`, un motif `dossier/**` en `allow` chacun |
| Serveurs MCP du registre, serveur de Sillage | `mcp.<nom>`, `local` ou `remote` |
| Bibliothèque de skills | `skills.paths` ; ils apparaissent parmi les commandes en `/` |
| Consignes tenues dans SILLAGE.md | `system` de chaque message ; `OPENCODE_DISABLE_PROJECT_CONFIG=1` masque `AGENTS.md` et `CLAUDE.md` du dépôt |

`OPENCODE_DISABLE_PROJECT_CONFIG` coupe aussi l'`opencode.json` et le dossier
`.opencode/` du projet : opencode n'a pas d'interrupteur plus fin. Un projet qui garde
ses consignes dans son dépôt n'est pas concerné.

## Comportements relevés

- **Port** : choisi par Sillage. Avec `--port 0`, opencode reprend 4096 pendant que le
  serveur précédent s'éteint encore, et la première connexion du nouveau est coupée.
- **Mot de passe** : un par process (`OPENCODE_SERVER_PASSWORD`, utilisateur `opencode`).
- **Infléchir** : un `prompt_async` reçu pendant un tour est pris à l'étape de modèle
  suivante, sans passage par `idle`.
- **Fin de tour** : `session.idle`, envoyé deux fois. À l'interruption il précède la
  clôture des outils en cours, et les demandes de permission restent dans la liste
  d'opencode sans `permission.replied` : le runner clôt tout lui-même.
- **Fork** : `POST /session/{id}/fork` copie les messages qui précèdent `messageID`, lui
  exclu. Sans `messageID`, tout est copié.
- **Commandes en `/`** : `POST /session/{id}/command`, qui ne répond qu'à la fin du tour.
- **Skills ajoutés en cours de route** : invisibles tant que l'instance n'est pas jetée
  (`POST /instance/dispose`). Le flux ouvert devient alors muet sans se fermer, il faut
  le rebrancher. Fait au repos seulement, un tour en cours partirait avec l'instance.
- **Sous-agents** : une session enfant par appel `task`, nommée dans les métadonnées de
  l'appel (`metadata.sessionId`). Ses événements arrivent sur le même flux.
- **Sortie d'une commande** : cumulée dans `metadata.output` de l'appel en cours.
- **Images et fichiers mentionnés** : parts `file` avec une URL `file://`, qu'opencode
  lit lui-même.

## Hors périmètre de la première version

Connexion des fournisseurs depuis l'interface (passer par `opencode auth login`), coût
cumulé, import des sessions commencées dans opencode, élicitations MCP.

## Vérifications

```sh
pnpm typecheck
pnpm test
pnpm opencode:types:check # compare les bindings au binaire installé
pnpm test:opencode-ui     # vrais composants, API simulée, ordinateur et mobile
```

La sonde manuelle `pnpm --filter @sillage/server opencode:probe` fait un vrai tour sur
l'opencode installé, avec le modèle gratuit `opencode/big-pickle`. Elle laisse une
session dans la base d'opencode et affiche son identifiant, à supprimer avec
`opencode session delete <id>`.

Pour mettre à jour l'API : lancer `pnpm opencode:types`, relire le diff, corriger
`packages/opencode-bindings/src/index.ts` si un schéma a bougé, puis relancer la sonde.
