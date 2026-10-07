# Hiérarchie de l’activité

Le titre de la session devient le premier niveau de lecture ; le projet reste visible sous chaque titre. La barre latérale affiche directement les quatre premières sessions actives, avec les attentes en tête, puis un accès à la liste complète. Le repli global reste disponible.

Dans la vue globale, les sections distinguent les demandes à débloquer, le travail en cours et les fins de tour. Le statut est aligné à droite sur ordinateur et rejoint le projet sous le titre sur téléphone. La sélection utilise un fond neutre et un liseré, pour ne pas concurrencer les attentes. Les couleurs et la police restent celles du thème Sillage.

Vérifications : `NODE_ENV=development pnpm typecheck`, `NODE_ENV=development pnpm test` (142 tests), `NODE_ENV=development pnpm lint`, `NODE_ENV=development node scripts/activity-ui-check.mjs`.

Playwright utilise une base temporaire et des statuts simulés : attente prioritaire, accès direct, repli, filtres, fins de tour, arrière-plan, erreurs, ajout d’une session, restauration du focus, absence de débordement horizontal. Captures en 1440 × 900 et 390 × 844, avec thèmes sombre et clair pour la vue globale. Aucun CLI lancé ni redémarrage de production.

- [Barre latérale](activity-expanded.png)
- [Vue globale sombre](activity-overview.png)
- [Vue globale claire](activity-overview-light.png)
- [Navigation mobile](activity-mobile.png)
- [Vue globale mobile](activity-overview-mobile.png)
