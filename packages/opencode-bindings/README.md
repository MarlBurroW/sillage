# @sillage/opencode-bindings

TypeScript bindings for the `opencode serve` HTTP API, generated from the OpenAPI
the installed binary publishes (`pnpm opencode:types`). A separate package for the
same reason as `@sillage/codex-bindings`: `@sillage/protocol` remains CLI-neutral.

Sillage speaks both OpenCode majors, which ship different servers:

- OpenCode 1 bindings generated with **opencode 1.19.5**: `src/openapi.d.ts`, read from
  `GET /doc`, short names in `src/index.ts` (`@sillage/opencode-bindings`).
- OpenCode 2 bindings generated with **opencode 2.4.1**: `src/v2/openapi.d.ts`, read from
  `GET /openapi.json`, short names in `src/v2/index.ts` (`@sillage/opencode-bindings/v2`).

The script writes the bindings of the binary it runs (`OPENCODE_BIN`, otherwise
`~/.opencode/bin/opencode`): point it at each major in turn. For OpenCode 2 it runs the
server under a scratch `HOME`, because a first 2.x start migrates the machine's session
database.

`openapi.d.ts` files are generated and must not be edited. The `index.ts` files are
handwritten: they give short names to schemas used by the adapters, and stop compiling
when one disappears from the API. `pnpm opencode:types:check` fails if committed content
has drifted from the binary.

The 1.x document already describes an early draft of the second generation
(`/api/session/...`, `session.next.*`); the OpenCode 1 adapter ignores it. See
`apps/server/src/agents/opencode/`.
