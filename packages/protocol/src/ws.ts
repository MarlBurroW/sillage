import { z } from 'zod'
import { conversationStatusSchema } from './api.js'
import type { SillageEvent } from './events.js'

/**
 * Une seule connexion WebSocket par onglet, multiplexée sur plusieurs conversations
 * (la sidebar suit les statuts pendant que la vue principale suit un fil).
 */

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('subscribe'),
    conversationId: z.string(),
    afterSeq: z.number().int().min(0),
  }),
  z.object({ t: z.literal('unsubscribe'), conversationId: z.string() }),
  z.object({ t: z.literal('ping') }),
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

export type ServerMessage =
  | {
      t: 'event'
      conversationId: string
      seq: number
      ts: number
      event: SillageEvent
    }
  | {
      t: 'status'
      conversationId: string
      status: z.infer<typeof conversationStatusSchema>
      /**
       * Vrai si un process CLI est encore vivant pour cette conversation.
       *
       * Distinct du statut : une conversation au repos peut avoir gardé sa session
       * chargée, ou l'avoir laissée expirer. Le prochain message coûte alors le
       * redémarrage du CLI et le rechargement du contexte, ce que l'utilisateur a
       * intérêt à savoir avant de se demander pourquoi la réponse tarde.
       */
      warm: boolean
    }
  /**
   * Le CLI a proposé un titre pour la conversation. Poussé plutôt que redécouvert par
   * rafraîchissement : le titre arrive après la fin du tour, donc une invalidation
   * déclenchée sur ce même signal courrait après lui.
   */
  | { t: 'title'; conversationId: string; title: string }
  /**
   * Le retard dépasse CATCHUP_THRESHOLD : le client doit recharger par la route REST
   * paginée plutôt que de recevoir le delta sur le socket.
   */
  | { t: 'catchup'; conversationId: string; fromSeq: number; toSeq: number }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string }

export const CATCHUP_THRESHOLD = 500
export const HEARTBEAT_INTERVAL_MS = 25_000
