# API publique

L’API `/api/v1` s’authentifie avec `Authorization: Bearer <clé>`.
Les clés se créent dans les réglages API de Sillage.

## Créer un projet

`POST /api/v1/projects` exige la permission `projects:write` et une clé sans
restriction de projets. Les clés existantes ne reçoivent pas cette permission
automatiquement : créer une nouvelle clé en la cochant.

Pour rattacher un dossier existant sur le serveur :

```json
{
  "name": "Mon projet",
  "workspacePath": "/home/marlburrow/projects/mon-projet"
}
```

Pour créer un dossier dans un parent existant :

```json
{
  "name": "Mon projet",
  "parentDir": "/home/marlburrow/projects",
  "directory": "mon-projet"
}
```

Les chemins sont absolus et désignent le système de fichiers du serveur.
`directory` doit être un simple nom de dossier ; une destination existante doit
être vide. Cette route ne clone pas de dépôt Git.

Options communes : `visibility` (`private` par défaut ou `shared`), `color`
(`#RRGGBB` ou `null`) et `instructionsMode` (`repo` ou `sillage`). Sans mode
explicite, la présence d’un fichier de consignes dans le dossier détermine le mode,
comme dans l’interface. Le propriétaire est l’utilisateur de la clé.

La réponse `201` a le même format qu’un élément de `GET /api/v1/projects` :
`id`, `name`, `workspacePath`, `git` (booléen), `worktrees` et `defaults`.
L’identifiant peut servir immédiatement à `POST /api/v1/projects/:id/tasks`
avec la permission `tasks:write`. La découverte exige `projects:read`.

Erreurs : `401` pour une clé absente ou invalide, `403` pour une permission absente
(`scope_missing`) ou une clé restreinte (`project_creation_restricted`), `400`
pour un corps ou chemin invalide, `409` pour un dossier de destination non vide.
La création n’est pas idempotente : répéter un appel réussi crée une nouvelle
entrée de projet.
