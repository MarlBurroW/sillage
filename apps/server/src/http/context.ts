import type { ApiTokenRow, Db, UserRow } from '@sillage/db'
import type { Config } from '../config.js'

export interface AppContext {
  db: Db
  config: Config
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Renseigné par le hook d'authentification, absent sur les routes publiques. */
    user?: UserRow
    /**
     * Jeton d'API présenté en Bearer, quand l'appelant est une machine. `user` porte
     * alors son propriétaire : un jeton emprunte une identité, il n'en crée pas.
     */
    apiToken?: ApiTokenRow
  }
}
