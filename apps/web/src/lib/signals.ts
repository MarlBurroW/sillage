import type { ConversationStatus } from '@sillage/protocol'
import type { BackgroundWork } from './background'
import type { QueuedMessage } from './chat-fold'
import { translate } from './i18n'
import { describeSchedule, formatAgo, type ArmedLoop } from './loops'
import { subAgentLabel, type SubAgent } from './subagents'

/**
 * Ce qui se passe dans une conversation, sous une forme unique que l'en-tête, le
 * composer et la liste des conversations affichent chacun à leur densité.
 *
 * Une seule dérivation pour trois surfaces : jusqu'ici chacune décidait de son côté
 * quoi montrer et de quelle couleur, et les mêmes travaux de fond apparaissaient en
 * violet à trois endroits sans que rien ne garantisse qu'ils disent la même chose.
 *
 * Les familles disent ce que le lecteur doit en faire, et non de quelle fonctionnalité
 * le signal vient. C'est ce qui borne la palette : deux signaux d'une même famille se
 * distinguent par leur icône et leur libellé, jamais par leur couleur.
 */

export type SignalFamily =
  /** Quelque chose tourne en ce moment. */
  | 'working'
  /** Rien ne tourne, mais la conversation repartira d'elle-même. */
  | 'scheduled'
  /** L'agent ou la liaison attend quelque chose de l'utilisateur. */
  | 'awaiting'
  /** Un état qui invalide ce qu'on lit. */
  | 'broken'

export type SignalKind =
  | 'subagents'
  | 'background'
  | 'running'
  | 'loop'
  | 'awaiting'
  | 'queued'
  | 'interrupted'
  | 'offline'
  | 'error'
  | 'pending'

export const SIGNAL_FAMILY: Record<SignalKind, SignalFamily> = {
  subagents: 'working',
  background: 'working',
  running: 'working',
  loop: 'scheduled',
  awaiting: 'awaiting',
  queued: 'awaiting',
  interrupted: 'awaiting',
  offline: 'awaiting',
  pending: 'awaiting',
  error: 'broken',
}

export interface Signal {
  kind: SignalKind
  family: SignalFamily
  /** Libellé traduit, tel qu'il s'affiche quand la place le permet. */
  label: string
  /** Ce que l'infobulle ajoute, vide quand le libellé se suffit. */
  detail: string
}

/**
 * L'ordre est celui des familles, pas celui des fonctionnalités : les couleurs se
 * suivent au lieu d'alterner, et la ligne se lit de gauche à droite du plus courant au
 * plus grave.
 */
const ORDER: SignalKind[] = [
  'running',
  'subagents',
  'background',
  'loop',
  'queued',
  'awaiting',
  'pending',
  'interrupted',
  'offline',
  'error',
]

export interface SignalInput {
  status: ConversationStatus
  connected: boolean
  subAgents: SubAgent[]
  background: BackgroundWork[]
  loops: ArmedLoop[]
  queued: QueuedMessage[]
  /**
   * Ce que le CLI applique encore, alors qu'un autre réglage est enregistré et affiché.
   * Vide quand les deux coïncident, c'est-à-dire hors de l'attente d'un redémarrage.
   */
  pending: string | null
  /**
   * Horodatage de rendu, pour l'ancienneté des réveils. Passé plutôt que lu ici : une
   * dérivation qui lit l'heure ne redonne pas le même résultat deux fois de suite, et
   * plus rien ne serait mémoïsable.
   */
  now: number
}

export function buildSignals(input: SignalInput): Signal[] {
  const found = new Map<SignalKind, Signal>()
  const add = (kind: SignalKind, label: string, detail = '') => {
    found.set(kind, { kind, family: SIGNAL_FAMILY[kind], label, detail })
  }

  if (input.status === 'running') add('running', translate('signal.running'))

  if (input.subAgents.length > 0) {
    add(
      'subagents',
      plural('signal.subagents', input.subAgents.length),
      input.subAgents
        .map((agent) =>
          agent.activity ? `${subAgentLabel(agent)} · ${agent.activity}` : subAgentLabel(agent),
        )
        .join('\n'),
    )
  }

  if (input.background.length > 0) {
    add(
      'background',
      plural('signal.background', input.background.length),
      input.background
        .map((task) => (task.activity ? `${task.description} · ${task.activity}` : task.description))
        .join('\n'),
    )
  }

  if (input.loops.length > 0) {
    add('loop', plural('signal.loop', input.loops.length), describeLoops(input.loops, input.now))
  }

  if (input.queued.length > 0) {
    add(
      'queued',
      plural('signal.queued', input.queued.length),
      input.queued.map((message) => message.text).join('\n'),
    )
  }

  // Avant les états de statut : ce qui gouverne le tour prime sur ce que le tour fait.
  if (input.pending) {
    add('pending', translate('signal.pending'), translate('signal.pending.detail', { value: input.pending }))
  }

  if (input.status === 'awaiting_input') add('awaiting', translate('signal.awaiting'))
  if (input.status === 'interrupted') add('interrupted', translate('signal.interrupted'))
  if (input.status === 'error') add('error', translate('signal.error'))

  // L'ambiant ne devient un signal que lorsqu'il tourne mal : une liaison qui marche
  // n'a rien à dire, une liaison coupée invalide tout ce que la page affiche.
  if (!input.connected) add('offline', translate('signal.offline'), translate('signal.offline.detail'))

  return sorted(found)
}

/**
 * Les signaux d'une conversation qu'on n'a pas ouverte.
 *
 * La liste des conversations n'a pas de journal à replier : elle ne reçoit que des
 * compteurs par le flux de statuts. Elle en tire les mêmes signaux, sans les détails
 * qu'aucune infobulle n'affichera de toute façon sur une ligne de six pixels.
 */
export function buildSidebarSignals(input: {
  status: ConversationStatus
  background: number
  loops: number
}): Signal[] {
  const found = new Map<SignalKind, Signal>()
  const add = (kind: SignalKind, label: string) => {
    found.set(kind, { kind, family: SIGNAL_FAMILY[kind], label, detail: '' })
  }

  if (input.status === 'running') add('running', translate('signal.running'))
  if (input.status === 'awaiting_input') add('awaiting', translate('signal.awaiting'))
  if (input.status === 'error') add('error', translate('signal.error'))
  if (input.status === 'interrupted') add('interrupted', translate('signal.interrupted'))
  if (input.background > 0) add('background', plural('signal.background', input.background))
  if (input.loops > 0) add('loop', plural('signal.loop', input.loops))

  return sorted(found)
}

function sorted(found: Map<SignalKind, Signal>): Signal[] {
  return ORDER.flatMap((kind) => {
    const signal = found.get(kind)
    return signal ? [signal] : []
  })
}

/**
 * Le catalogue n'a pas de règle de pluriel : le choix se fait à l'appel, comme
 * partout ailleurs. Le préfixe est restreint aux clés qui existent en `.one` et
 * `.many`, ce qui fait vérifier la concaténation par le compilateur.
 */
type PluralPrefix =
  | 'signal.subagents'
  | 'signal.background'
  | 'signal.loop'
  | 'signal.queued'
  | 'conversation.loop.iterations'

function plural(prefix: PluralPrefix, count: number): string {
  return translate(`${prefix}.${count > 1 ? 'many' : 'one'}`, { count })
}

/** Cadence, réveils comptés et ancienneté du dernier, une boucle par ligne. */
function describeLoops(loops: ArmedLoop[], now: number): string {
  return loops
    .map((loop) => {
      const cadence = loop.recurring
        ? (describeSchedule(loop.schedule) ?? loop.schedule)
        : translate('conversation.loop.oneShot')
      const fired =
        loop.lastFiredAt === null
          ? translate('conversation.loop.pending')
          : translate('conversation.loop.lastFired', { ago: formatAgo(now - loop.lastFiredAt) })
      const runs = plural('conversation.loop.iterations', loop.iterations)
      return `${cadence} · ${runs} · ${fired}\n${loop.prompt}`
    })
    .join('\n\n')
}

/**
 * Le signal qui décrit le mieux l'état présent, ou null quand il n'y a rien à dire.
 *
 * Sert là où il n'y a la place que pour un point. Les boucles en sont exclues : elles
 * parlent de ce qui arrivera, pas de ce qui se passe, et restent donc affichables à
 * côté de celui-ci plutôt qu'en concurrence avec lui.
 */
const PRESENT_PRIORITY: SignalFamily[] = ['broken', 'awaiting', 'working']

export function presentSignal(signals: Signal[]): Signal | null {
  for (const family of PRESENT_PRIORITY) {
    const match = signals.find((signal) => signal.family === family)
    if (match) return match
  }
  return null
}
