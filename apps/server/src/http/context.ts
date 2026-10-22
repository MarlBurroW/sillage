import type { ApiTokenRow, Db, UserRow } from '@sillage/db'
import type { Config } from '../config.js'

export interface AppContext {
  db: Db
  config: Config
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook; absent on public routes. */
    user?: UserRow
    /**
     * API token presented as Bearer by machine callers. `user` then holds its
     * owner: tokens borrow identities rather than create them.
     */
    apiToken?: ApiTokenRow
  }
}
