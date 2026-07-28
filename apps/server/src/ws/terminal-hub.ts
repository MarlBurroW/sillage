import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import {
  terminalClientMessageSchema,
  type TerminalServerMessage,
} from '@sillage/protocol'
import { TerminalError, type TerminalManager } from '../terminals/terminal-manager.js'
import type { AppContext } from '../http/context.js'
import { canReadConversation } from '../http/routes/conversations.js'

/**
 * Socket du terminal, séparée de celle du journal.
 *
 * Un socket par vue de terminal ouverte, et non un multiplexage : il n'y a qu'un
 * terminal visible à la fois, et le débit d'une sortie de compilation n'a pas à
 * ralentir la diffusion des événements de conversation.
 */
export function registerTerminalHub(
  app: FastifyInstance,
  ctx: AppContext,
  terminals: TerminalManager,
): void {
  app.get<{ Params: { id: string }; Querystring: { terminalId?: string } }>(
    '/api/conversations/:id/terminal',
    { websocket: true },
    (socket: WebSocket, request) => {
      const user = request.user
      if (!user) {
        socket.close(4401, 'unauthorized')
        return
      }

      const conversationId = request.params.id
      if (!canReadConversation(ctx, conversationId, user.id)) {
        socket.close(4404, 'not_found')
        return
      }

      const send = (message: TerminalServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      }

      // Le terminal est ouvert par la route REST, jamais par la socket : c'est elle
      // qui applique le plafond et rend l'identifiant, et une socket qui créerait à
      // l'attachement en ouvrirait un à chaque reconnexion.
      const terminalId = request.query.terminalId ?? ''

      let attached
      try {
        attached = terminals.attach(conversationId, terminalId, {
          onOutput: (data) => send({ t: 'output', data }),
          // La socket reste ouverte : le client garde l'écran final à l'écran, et
          // c'est la fermeture de l'onglet qui décide de s'en défaire.
          onExit: (code) => send({ t: 'exit', code }),
        })
      } catch (err) {
        const code = err instanceof TerminalError ? err.code : 'terminal_unavailable'
        send({ t: 'error', code, message: err instanceof Error ? err.message : String(err) })
        socket.close()
        return
      }

      send({
        t: 'ready',
        replay: attached.replay,
        cols: attached.cols,
        rows: attached.rows,
        exited: attached.exited,
      })

      socket.on('message', (raw: Buffer) => {
        let parsed
        try {
          parsed = terminalClientMessageSchema.parse(JSON.parse(raw.toString()))
        } catch {
          send({ t: 'error', code: 'bad_message', message: 'Unreadable message.' })
          return
        }

        if (parsed.t === 'input') terminals.write(conversationId, terminalId, parsed.data)
        else terminals.resize(conversationId, terminalId, parsed.cols, parsed.rows)
      })

      // Le terminal continue de tourner : fermer l'onglet ne doit pas interrompre une
      // commande en cours. C'est l'inactivité prolongée qui finit par le libérer.
      socket.on('close', attached.detach)
    },
  )
}
