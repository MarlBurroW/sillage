# La marque : L’écho

Trois ondes parallèles prolongent un mouvement. Ce dessin a été choisi parmi les
propositions de logo : il évoque la trace du travail et la continuité des échanges.

## Sources

| Fichier | Usage |
| --- | --- |
| `docs/brand/symbol.svg` | Tracé de référence, sans police, en `currentColor`. |
| `docs/brand/logo-{noir,blanc,couleur}.svg` | Signatures exportables, lettrage Lato Bold vectorisé (licence jointe). |
| `docs/brand/wordmark.svg` | En-tête du README, avec sa description. |
| `apps/web/src/components/Logo.tsx` | Marque dans l’application, suit la couleur du thème. |
| `apps/web/public/favicon.svg` | Accent par défaut de l’application, variante sombre. |
| `site/favicon.svg`, `site/index.html` | Marque du site, suit sa palette. |

Les copies SVG autonomes portent les mêmes trois tracés et le même repère 100 × 100.
Une modification du dessin demande de toutes les mettre à jour.

## Couleur et placement

Le vert #436E69 est la couleur de la signature autonome et des icônes d’application.
Dans les interfaces, `currentColor` conserve la palette du site et les thèmes choisis
par l’utilisateur. Les favicons suivent la préférence système clair/sombre.

Conserver autour du symbole une marge d’au moins 10 % de sa largeur. La signature
horizontale s’utilise à partir de 150 px ; en dessous, préférer le symbole seul.

## Régénérer les PNG

Depuis la racine du dépôt : `node scripts/brand-assets.mjs`.
Le script utilise Playwright, déjà présent dans les dépendances de développement.

| Fichier | Format | Particularité |
| --- | --- | --- |
| `apps/web/public/icon-192.png` | 192 × 192 | Tuile arrondie, manifest et notifications. |
| `apps/web/public/icon-512.png` | 512 × 512 | Tuile arrondie, manifest. |
| `apps/web/public/icon-maskable-512.png` | 512 × 512 | Fond plein ; symbole dans le cercle de sécurité de 80 %. |
| `apps/web/public/apple-touch-icon.png` | 180 × 180 | Fond plein ; iOS applique son propre masque. |
| `apps/web/public/og.png`, `site/og.png` | 1200 × 630 | Vignette de partage. |

Les captures du produit dans `site/screenshots` sont régénérées avec
`scripts/screenshots.mjs` sur une instance de démonstration isolée.
