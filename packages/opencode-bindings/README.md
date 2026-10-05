# @sillage/opencode-bindings

Bindings TypeScript de l'API HTTP d'`opencode serve`, générés depuis l'OpenAPI que le
binaire installé publie sur `GET /doc` (`pnpm opencode:types`). Paquet à part pour la
même raison que `@sillage/codex-bindings` : `@sillage/protocol` reste neutre vis-à-vis
des CLI.

Généré avec **opencode 1.18.25**.

`src/openapi.d.ts` est généré et ne se retouche pas. `src/index.ts` est écrit à la
main : il donne un nom court aux schémas dont l'adaptateur se sert, et c'est lui qui
cesse de compiler quand l'un d'eux disparaît de l'API. `pnpm opencode:types:check`
échoue si le contenu committé a dérivé du binaire.

Deux générations d'API cohabitent dans ce document (`/session/...` et
`/api/session/...`, événements `session.next.*`, permissions et questions V1 et V2).
L'adaptateur ne parle que la première, voir `apps/server/src/agents/opencode/`.
