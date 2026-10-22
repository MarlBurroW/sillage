import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import {
  terminalClientMessageSchema,
  type TerminalServerMessage,
} from '@sillage/protocol'
import { TerminalError, type TerminalManager } from '../terminals/terminal-manager.js'
import type { AppContext } from '../http/context.js'
import { visibleProject } from '../http/routes/projects.js'

/** Terminal socket separate from the journal socket. One socket per open terminal view rather than multiplexing: only one terminal is visible at once, and build output must not slow conversation-event delivery. */
export function registerTerminalHub(
  app: FastifyInstance,
  ctx: AppContext,
  terminals: TerminalManager,
): void {
  app.get<{ Params: { id: string }; Querystring: { terminalId?: string } }>(
    '/api/projects/:id/terminal',
    { websocket: true },
    (socket: WebSocket, request) => {
      const user = request.user
      if (!user) {
        socket.close(4401, 'unauthorized')
        return
      }

      const projectId = request.params.id
      if (!visibleProject(ctx, projectId, user.id)) {
        socket.close(4404, 'not_found')
        return
      }

      const send = (message: TerminalServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      }

      // REST opens terminals, never sockets: the route is
      // which enforces limits and returns IDs; creating terminals on socket attachment
      // would open another on every reconnect.
      const terminalId = request.query.terminalId ?? ''

      let attached
      try {
        attached = terminals.attach(projectId, terminalId, {
          onOutput: (data) => send({ t: 'output', data }),
          // Keep sockets open so clients retain the final screen;
          // closing the tab decides when to discard it.
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

        if (parsed.t === 'input') terminals.write(projectId, terminalId, parsed.data)
        else terminals.resize(projectId, terminalId, parsed.cols, parsed.rows)
      })

      // Keep terminals running: closing tabs must not interrupt active commands.
      // Extended inactivity eventually releases them.
      socket.on('close', attached.detach)
    },
  )
}
