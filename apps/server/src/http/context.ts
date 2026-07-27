import type { Db, UserRow } from '@sillage/db'
import type { Config } from '../config.js'

export interface AppContext {
  db: Db
  config: Config
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Renseigné par le hook d'authentification, absent sur les routes publiques. */
    user?: UserRow
  }
}
