# Propositions d’indicateurs de saisie

Page autonome de comparaison, sans intégration à la conversation de production.
Six mouvements : Écho, Onde, Orbite, Encre, Constellation et Souffle. L’utilisateur a
retenu Écho, sous le nom « Sillage », comme défaut, avec les six choix dans Apparence.
L’intégration est préparée dans le même worktree, sans déploiement.

## Direction visuelle

Reprendre les couleurs et la police de Sillage permet de juger les animations dans
leur contexte. Les jetons sont copiés depuis `apps/web/src/styles/tokens.css` à la
construction ; les valeurs ci-dessous sont de simples repères de conception :

- Fond prune sombre `#17121a`, surface `#211b25`, ligne `#39303e`.
- Encre claire `#f5f2f7`, encre secondaire `#c2b8c8`, accent lilas `#cb8ddd`.
- Police système de Sillage : titre 48 px, titres de choix 14 px, légendes 11 px.

Le mouvement porte la personnalité ; la page reste calme. Les six cases servent
à comparer des alternatives, l’aperçu à droite montre leur taille en conversation.
Les textes sont alignés à gauche. Le repère latéral de la description reste droit.

```text
Sillage                                      thème / langue
Une idée prend forme.

Choisir un mouvement                 Dans la conversation
[ Écho      ][ Onde          ]       [ question            ]
[ Orbite    ][ Encre         ]       [ réponse + indicateur]
[ Étoiles   ][ Souffle       ]       [ saisie              ]
rythme / accent / pause              Réflexion / Rédaction
                                    Description du choix
```

Sur téléphone, les choix précèdent la conversation et un lien permet de rejoindre
l’aperçu sans chercher. Pas d’image ni de police distante. Le logo Écho reprend le
tracé de référence dans `docs/brand/symbol.svg` ; sa forme n’est pas redessinée.

## Construire et servir

Depuis la racine du worktree, avec Node 24 :

```sh
node docs/prototypes/typing-indicators/build.mjs
```

Sortie par défaut : `/var/tmp/sillage-typing-proposals`. Un premier argument permet
de choisir un autre dossier. Les traductions françaises et anglaises sont extraites
des catalogues de l’application, sous `prototype.typing.*`.

L’aperçu du 22 octobre 2026 écoute en privé sur le port 7476, exposé par Tailscale :
<http://marldev.tail710c78.ts.net:7476>.

L’unité temporaire reste active après la session, jusqu’à son arrêt ou au prochain
redémarrage de la machine. Elle est visible dans **Services** de Sillage.

```sh
systemctl --user list-units 'sillage-app-*'
systemctl --user stop sillage-app-typing-proposals
# Retirer aussi l’exposition si l’aperçu n’est plus utile.
sudo tailscale serve --http=7476 off
```

## Vérifications

```sh
NODE_ENV=development node docs/prototypes/typing-indicators/ui-check.mjs
```

Le parcours vérifie les six choix, les thèmes, les langues, le rythme, la pause,
la couleur, les états réflexion/rédaction, le clavier, le mouvement réduit et les
largeurs 1440, 768, 390 et 320 px. Captures dans `/var/tmp/sillage-typing-ui`.
`TYPING_PROPOSALS_URL` et `TYPING_PROPOSALS_OUTPUT` remplacent les valeurs par défaut.

`pnpm typecheck`, `pnpm test` (345 tests) et `pnpm lint` passent également.
Server et Desktop utilisent ici la même maquette statique : aucune dépendance à
l’authentification, aux notifications ou au profil du serveur. Aucun comportement
de ces éditions n’est modifié par cette étude.

## Intégration retenue

`TypingIndicator` fournit les dessins au fil (`TurnActivity`) et aux réglages
(`TypingIndicatorControls`). Le store `lib/typing-indicator.ts` conserve le choix
local ; `appearance-sync.ts` l’enregistre avec les autres préférences du compte.
Un compte ancien ou un style inconnu reprend Sillage. Les animations réduites
gardent un dessin fixe, notamment pour éviter de faire disparaître Encre.

Validation de l’intégration : `pnpm test:typing-indicator-ui`, typecheck, lint,
346 tests et build web. Les captures sont dans `/var/tmp/sillage-typing-integrated`.
Le parcours couvre le rechargement et un second navigateur sans cache, les trois
thèmes, le clavier, le téléphone et le mouvement réduit. Le test serveur
`appearance.test.ts` vérifie le passage par l’API et la base.

Server et Desktop utilisent les mêmes composants et la même route de préférences.
Pas de migration SQL ; déployer serveur et web ensemble, car le schéma partagé doit
conserver le nouveau champ `appearance.typingIndicator`.
