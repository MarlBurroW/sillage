import {
  AlertTriangle,
  Bot,
  Hand,
  Hourglass,
  Layers,
  Pause,
  Repeat,
  Waves,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import type { Signal, SignalFamily, SignalKind } from '../../lib/signals'
import { cx } from '../ui'

/**
 * Le rendu commun des signaux d'une conversation.
 *
 * Une seule table d'icônes et de couleurs pour toutes les surfaces : c'est ce qui rend
 * la cohérence structurelle plutôt que conventionnelle. Ajouter un signal se fait ici
 * et dans `buildSignals`, et il apparaît partout du même coup.
 */

const ICONS: Record<SignalKind, LucideIcon> = {
  running: Bot,
  subagents: Bot,
  background: Waves,
  loop: Repeat,
  queued: Layers,
  awaiting: Hand,
  interrupted: Pause,
  pending: Hourglass,
  offline: WifiOff,
  error: AlertTriangle,
}

/** La couleur appartient à la famille, jamais au signal : c'est la règle de la palette. */
const TEXT: Record<SignalFamily, string> = {
  working: 'text-accent',
  scheduled: 'text-loop',
  awaiting: 'text-caution',
  broken: 'text-critical',
}

const DOT: Record<SignalFamily, string> = {
  working: 'bg-accent',
  scheduled: 'bg-loop',
  awaiting: 'bg-caution',
  broken: 'bg-critical',
}

/**
 * Seul ce qui tourne vraiment clignote. Une boucle armée attend, une erreur ne bouge
 * plus, et une attente de réponse ne gagne rien à s'agiter.
 */
function pulses(signal: Signal): boolean {
  return signal.family === 'working'
}

export function SignalChip({ signal, onClick }: { signal: Signal; onClick?: () => void }) {
  const Icon = ICONS[signal.kind]
  const content = (
    <>
      <Icon size={11} className={cx('shrink-0', pulses(signal) && 'animate-pulse')} />
      <span className="truncate">{signal.label}</span>
    </>
  )
  const className = cx(
    'flex min-w-0 shrink items-center gap-1.5 text-[0.6875rem] font-medium',
    TEXT[signal.family],
  )
  const title = signal.detail || signal.label

  if (!onClick) {
    return (
      <span className={className} title={title}>
        {content}
      </span>
    )
  }

  return (
    <button type="button" onClick={onClick} title={title} className={cx(className, 'hover:underline')}>
      {content}
    </button>
  )
}

/**
 * Les signaux dont le détail existe ailleurs. Le panneau latéral, onglet Agents, tient
 * déjà la liste des sous-agents avec leur fil et celle des travaux de fond. Les autres
 * n'ont rien de plus à montrer qu'une infobulle.
 */
const OPENS_PANEL = new Set<SignalKind>(['subagents', 'background'])

/** Rangée de signaux. Ne rend rien quand il n'y en a aucun, plutôt qu'une ligne vide. */
export function SignalRow({
  signals,
  onSelect,
  className,
}: {
  signals: Signal[]
  /** Appelé pour les signaux qui mènent quelque part. Les autres restent inertes. */
  onSelect?: (kind: SignalKind) => void
  className?: string
}) {
  if (signals.length === 0) return null

  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {signals.map((signal) => (
        <SignalChip
          key={signal.kind}
          signal={signal}
          onClick={onSelect && OPENS_PANEL.has(signal.kind) ? () => onSelect(signal.kind) : undefined}
        />
      ))}
    </div>
  )
}

/** Le même vocabulaire réduit à un point, là où il n'y a de place que pour ça. */
export function SignalDot({ signal }: { signal: Signal }) {
  return (
    <span
      aria-label={signal.label}
      title={signal.detail || signal.label}
      className={cx('size-1.5 rounded-full', DOT[signal.family], pulses(signal) && 'animate-pulse')}
    />
  )
}
