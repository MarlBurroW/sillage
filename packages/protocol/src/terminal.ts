import { z } from 'zod'

/**
 * Dedicated terminal socket, separate from the journal socket.
 *
 * Shell output is not conversation content: it does not follow invariant I2, is never
 * persisted, and its throughput would queue thread events behind kilobytes of build output if
 * both shared one connection.
 */

/** Beyond this, input is an oversized paste rather than typing. */
export const MAX_TERMINAL_INPUT = 64 * 1024

/**
 * Simultaneously open terminals per project.
 *
 * Shells are live processes: without a limit, an open project would accumulate one for every
 * “+” click. Shared rather than server-only so the UI can disable the button before rejection.
 */
export const MAX_TERMINALS_PER_PROJECT = 6

export interface TerminalDto {
  id: string
  title: string
  /** False when the shell has exited but its tab remains displayed. */
  alive: boolean
  /** The process was lost in a daemon restart, but its screen remains. */
  interrupted: boolean
  /** Shell directory: the project workspace or a worktree. */
  cwd: string
  createdAt: number
  /** Project action that opened this terminal to run its command. */
  actionId: string | null
  /** Exit code of a completed action command; null for shells or while running. */
  exitCode: number | null
}

export const renameTerminalBodySchema = z.object({ title: z.string().min(1).max(60) })

/**
 * Opened from a session, the terminal uses its directory, including the worktree; otherwise the
 * project workspace. `cwd` restarts interrupted shells in their original directory: the server
 * accepts it only if it names the workspace or a still-existing project worktree.
 */
export const openTerminalBodySchema = z.object({
  conversationId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
})

export const terminalClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), data: z.string().max(MAX_TERMINAL_INPUT) }),
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
])
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>

export type TerminalServerMessage =
  /** Existing output sent on attachment to redraw the screen. */
  | { t: 'ready'; replay: string; cols: number; rows: number; exited: boolean }
  | { t: 'output'; data: string }
  | { t: 'exit'; code: number }
  | { t: 'error'; code: string; message: string }
