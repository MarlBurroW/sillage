# @sillage/opencode-bindings

TypeScript bindings for the `opencode serve` HTTP API, generated from the OpenAPI
the installed binary publishes at `GET /doc` (`pnpm opencode:types`). A separate
package for the same reason as `@sillage/codex-bindings`: `@sillage/protocol`
remains CLI-neutral.

Generated with **opencode 1.19.3**.

`src/openapi.d.ts` is generated and must not be edited. `src/index.ts` is handwritten:
it gives short names to schemas used by the adapter, and stops compiling when
one disappears from the API. `pnpm opencode:types:check` fails if committed content
has drifted from the binary.

Two API generations coexist in this document (`/session/...` and `/api/session/...`,
`session.next.*` events, V1 and V2 permissions and questions). The adapter uses
only the first; see `apps/server/src/agents/opencode/`.
