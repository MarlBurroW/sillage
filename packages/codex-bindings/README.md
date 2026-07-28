# @sillage/codex-bindings

Bindings TypeScript du protocole `codex app-server`, générés par le binaire Codex
installé (`pnpm codex:types`). Paquet à part : `@sillage/protocol` se déclare neutre
vis-à-vis des CLI, un dump de 500 fichiers d'un fournisseur n'y avait pas sa place.

Seuls l'adaptateur Codex du serveur et les assertions de dérive du protocole en
dépendent. `pnpm codex:types:check` échoue si le contenu committé a dérivé du binaire.
