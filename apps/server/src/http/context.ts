import type { ApiTokenRow, Db, UserRow } from '@sillage/db'
import type { Config } from '../config.js'
import type { RemoteAccessService } from '../remote-access/service.js'

export interface AppContext {
  db: Db
  config: Config
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Desktop remote access through Tailscale Serve; null on the server profile. */
    remoteAccess: RemoteAccessService | null
  }
  interface FastifyRequest {
    /** Set by the authentication hook; absent on public routes. */
    user?: UserRow
    /**
     * API token presented as Bearer by machine callers. `user` then holds its
     * owner: tokens borrow identities rather than create them.
     */
    apiToken?: ApiTokenRow
    /**
     * Tailnet login Tailscale Serve vouched for, set by the desktop guard. Absent means a
     * local request; the authentication hook opens a session for it when cookies carry none.
     */
    tailnetLogin?: string
  }
}
