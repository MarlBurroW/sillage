import { z } from 'zod'

/**
 * Socket dédiée au terminal, distincte de celle du journal.
 *
 * La sortie d'un shell n'est pas du contenu de conversation : elle ne suit pas
 * l'invariant I2, n'est jamais persistée, et son débit ferait passer les événements
 * du fil derrière des kilo-octets de sortie de compilation si les deux partageaient
 * la même connexion.
 */

/** Au-delà, ce n'est plus une frappe mais un collage démesuré. */
export const MAX_TERMINAL_INPUT = 64 * 1024

/**
 * Terminaux ouverts simultanément par projet.
 *
 * Un shell est un process qui vit : sans plafond, un projet laissé ouvert en
 * accumulerait autant qu'on a cliqué sur « + ». Partagé plutôt que côté serveur seul,
 * pour que l'interface sache griser le bouton au lieu d'attendre un refus.
 */
export const MAX_TERMINALS_PER_PROJECT = 6

export interface TerminalDto {
  id: string
  title: string
  /** Faux quand le shell s'est terminé mais que son onglet est encore affiché. */
  alive: boolean
  /** Le process a été emporté par un redémarrage du daemon ; l'écran, lui, est resté. */
  interrupted: boolean
  /** Répertoire du shell : le workspace du projet, ou un worktree. */
  cwd: string
  createdAt: number
}

export const renameTerminalBodySchema = z.object({ title: z.string().min(1).max(60) })

/**
 * Ouvert depuis une session, le terminal prend son répertoire (worktree compris) ;
 * sans rien, celui du workspace du projet. `cwd` sert à relancer un shell interrompu
 * là où il tournait : le serveur ne l'accepte que s'il désigne le workspace ou un
 * worktree encore vivant du projet.
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
  /** Sortie déjà produite, envoyée à l'attachement pour repeindre l'écran. */
  | { t: 'ready'; replay: string; cols: number; rows: number; exited: boolean }
  | { t: 'output'; data: string }
  | { t: 'exit'; code: number }
  | { t: 'error'; code: string; message: string }
