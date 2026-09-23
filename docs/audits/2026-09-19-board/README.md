# Board et édition des tickets

Le board propose une recherche par texte ou numéro, une création complète de ticket,
des colonnes avec repères colorés et des cartes plus lisibles. Sur mobile, la recherche
sélectionne une colonne contenant un résultat. Le déplacement reste disponible au
clavier ; il est désactivé pendant une recherche pour éviter de réordonner une liste
partielle.

La fiche est plus large et sépare Détails, Activité et Sessions. L'éditeur nomme ses
champs, propose un aperçu Markdown et garde ses actions d'enregistrement visibles.
Les brouillons restent conservés dans l'onglet. Ctrl/Cmd + Entrée enregistre ; lancer
une nouvelle session exige d'avoir enregistré les modifications.

Les pièces jointes s'ajoutent après création du ticket, par sélection multiple ou dépôt.
Elles sont enregistrées immédiatement, indépendamment du brouillon de description.
Les images ont une miniature, les fichiers un lien de consultation/téléchargement.
La limite est de 20 Mo par fichier. Les agents retrouvent nom, type, taille et chemin
local avec `read_card`. Les fichiers suivent la visibilité du projet.

## Stockage et installation

La migration `0025_eager_zarek.sql` ajoute `attachments.card_id` et son index. Elle
s'applique au démarrage du serveur. Les fichiers de tickets sont exclus du ramassage
des téléversements abandonnés et ne peuvent pas être réaffectés à un message de chat.
La suppression d'un ticket ou d'un projet retire ses fichiers ; la clé étrangère
`ON DELETE SET NULL` laisse aussi les fichiers collectables en cas de suppression
SQL directe. Les chemins locaux sont réservés à l'outil des agents, pas à l'API web.

## Vérifications

- `pnpm typecheck` et `pnpm build` : réussis.
- `pnpm test` : 37 tests réussis, dont upload, limites, droits, nettoyage et lecture MCP réelle.
- `pnpm test:board-ui` : création, brouillons, aperçu, raccourci de sauvegarde, ajout
  multiple, dépôt, lecture, échec/réessai, suppression, recherche, tri clavier et mobile.
- `pnpm test:ui` : suite complète réussie, y compris sauvegardes concurrentes,
  navigation clavier et absence de débordement de 320 à 1440 pixels.

Les captures de ce dossier sont produites par `scripts/board-ui-check.mjs`, sur une
base temporaire avec les agents désactivés. Les avertissements de build sur
`::highlight` et la taille des bundles préexistaient à cette refonte.

## Aperçu temporaire

Une instance de démonstration séparée, avec des données fictives et les agents
désactivés, tourne pendant 24 h sous l'unité utilisateur `sillage-board-preview`.
Elle est exposée uniquement via Tailscale sur le port 7620. Connexion de démonstration :
`alex` / `sillage-demo`. L'instance principale n'a pas été redéployée.

Pour fermer cet aperçu :

```sh
systemctl --user stop sillage-board-preview
sudo tailscale serve --http=7620 off
```
