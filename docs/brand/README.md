# La marque

Un point qui avance, et les rides qu'il laisse derrière lui. Les trois arcs sont le même
événement à trois instants : ils s'élargissent et s'effacent en s'éloignant, comme les
vagues transversales d'un vrai sillage. C'est aussi ce que le produit fait, un agent
travaille et le journal garde la trace.

## Où vit le tracé

Le dessin existe en trois exemplaires, qui ne peuvent pas s'importer les uns les autres.
Toucher à la géométrie demande de reprendre les trois, puis de régénérer les PNG.

| Fichier | Usage |
| --- | --- |
| `apps/web/src/components/Logo.tsx` | Dans l'application. Tracé en `currentColor`. |
| `apps/web/public/favicon.svg` | Onglet du navigateur. Couleurs figées, hors du document. |
| `docs/brand/wordmark.svg` | En-tête du README, avec le mot. |

## Couleur

Dans l'application, la marque est unie et prend `--sg-accent` : elle suit donc le curseur
de teinte des réglages, ce qu'un dégradé codé en dur ne saurait pas faire. Le dégradé ne
sert que là où la marque est posée sur une tuile, c'est-à-dire dans les icônes.

Les fichiers qui vivent hors du document (favicon, wordmark) ne peuvent hériter d'aucun
jeton : ils figent l'accent par défaut, teinte 275, avec une variante plus claire sous
`prefers-color-scheme: dark`.

## Fichiers dérivés

Rendus à partir du tracé, en blanc sur une tuile en dégradé `#6875f6` vers `#9f47b9` :

| Fichier | Format | Particularité |
| --- | --- | --- |
| `apps/web/public/icon-192.png` | 192, coins arrondis | Manifest, icône de notification |
| `apps/web/public/icon-512.png` | 512, coins arrondis | Manifest |
| `apps/web/public/icon-maskable-512.png` | 512, plein cadre | Motif dans le cercle de sécurité des 80 %. Une source arrondie serait rognée une seconde fois par Android. |
| `apps/web/public/apple-touch-icon.png` | 180, plein cadre | iOS applique son propre masque : une source déjà arrondie laisse des coins noirs. |
| `apps/web/public/og.png` | 1200 x 630 | Vignette de partage |

Il n'y a pas de script de génération : ces fichiers changent une fois tous les deux ans,
et une dépendance de rastérisation dans le monorepo coûterait plus cher que de les
refaire à la main le jour où le tracé bouge.
