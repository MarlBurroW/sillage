import type { AgentKind } from '@sillage/protocol'
import type { ReactNode } from 'react'
import { Bot, FilePen, Flame, GitPullRequestArrow, Globe, Snowflake, Timer, TriangleAlert, Wrench } from 'lucide-react'
import { AGENT_LABELS, AgentIcon } from '../../../apps/web/src/components/AgentIcon'
import { WORKTREE_STATE_TEXT } from '../../../apps/web/src/components/WorktreeTag'
import { cx } from '../../../apps/web/src/components/ui'
import {
  AGENT_DATA, SPEC, SUBAGENTS, formatReset, formatTokens, toneOf, windowsFor,
  type Entry, type Format, type Scenario, type Window,
} from './data'

/** One piece of the bar. A quota showing every window yields one piece per window. */
export interface Piece {
  id: string
  /** Inline content in the bar. */
  node: ReactNode
  /** Row label in the phone sheet. */
  name: string
  /** Row value in the phone sheet, roomier than the inline one. */
  value: ReactNode
  /** Tooltip on desktop, second line in the sheet. */
  detail: string
  /** Where a click leads, simulated in the mockup. */
  opens?: string
  end?: boolean
}

export interface RenderContext {
  agent: AgentKind
  scenario: Scenario
  /** Phone: bars fold into rings, labels shorten. */
  compact: boolean
  clock: number
}

const TONE_TEXT = { accent: 'text-ink-soft', caution: 'text-caution', critical: 'text-critical' }
const TONE_BG = { accent: 'bg-accent', caution: 'bg-caution', critical: 'bg-critical' }
const TONE_RING = { accent: 'text-accent', caution: 'text-caution', critical: 'text-critical' }

export function Bar({ ratio, width = 'w-12' }: { ratio: number; width?: string }) {
  const tone = toneOf(ratio)
  return (
    <span aria-hidden className={cx('inline-block h-1.5 shrink-0 overflow-hidden rounded-full bg-surface-high', width)}>
      <span className={cx('block h-full rounded-full', TONE_BG[tone])} style={{ width: `${Math.round(Math.min(ratio, 1) * 100)}%` }} />
    </span>
  )
}

export function Ring({ ratio, size = 13 }: { ratio: number; size?: number }) {
  const radius = 5
  const circumference = 2 * Math.PI * radius
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" className={cx('shrink-0', TONE_RING[toneOf(ratio)])}>
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.22" />
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.min(ratio, 1))} transform="rotate(-90 7 7)" />
    </svg>
  )
}

/** A proportion in the chosen format; phones fold bars into rings to keep one line. */
function Proportion({ ratio, label, text, format, compact }: { ratio: number; label?: string; text?: string; format: Format; compact: boolean }) {
  const percent = `${Math.round(ratio * 100)} %`
  const tone = TONE_TEXT[toneOf(ratio)]
  const shown = compact && format === 'bar' ? 'ring' : format
  return (
    <span className="flex items-center gap-1.5">
      {label ? <span>{label}</span> : null}
      {shown === 'bar' ? <Bar ratio={ratio} /> : null}
      {shown === 'ring' ? <Ring ratio={ratio} /> : null}
      <span className={cx('tabular-nums', tone)}>{shown === 'text' && text ? text : percent}</span>
    </span>
  )
}

function windowDetail(window: Window): string {
  const reset = formatReset(window.resetIn)
  return `${window.title} · ${Math.round(window.utilization * 100)} % utilisés${reset ? ` · reset dans ${reset}` : ''}`
}

function sheetBar(ratio: number) {
  return <span className="flex items-center gap-2"><Bar ratio={ratio} width="w-20" /><span className={cx('tabular-nums', TONE_TEXT[toneOf(ratio)])}>{Math.round(ratio * 100)} %</span></span>
}

function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The pieces an entry shows for this CLI and moment; empty when it has nothing to say. */
export function piecesOf(entry: Entry, context: RenderContext): Piece[] {
  const { agent, scenario, compact, clock } = context
  const spec = SPEC[entry.key]
  if (!entry.on) return []
  if (spec.support && !spec.support.includes(agent)) return []
  const data = AGENT_DATA[agent]
  const running = scenario === 'running'

  switch (entry.key) {
    case 'cli': {
      const warm = running
      const state = warm ? 'Session chargée' : 'Session au repos'
      const icon = warm ? <Flame size={11} /> : <Snowflake size={11} />
      return [{
        id: 'cli',
        node: <span className="flex items-center gap-1.5"><AgentIcon agent={agent} size={11} /><span className="flex items-center gap-1">{icon}{compact ? null : state}</span></span>,
        name: AGENT_LABELS[agent],
        value: <span className="flex items-center gap-1">{icon}{state}</span>,
        detail: warm ? 'Le process CLI tourne : le prochain message part immédiatement.' : 'Aucun process CLI : le prochain message relance la session et recharge son contexte.',
      }]
    }
    case 'quota': {
      const windows = windowsFor(agent, scenario)
      if (windows.length === 0) return []
      const shown = entry.option === 'all' ? windows : [windows.reduce((a, b) => (b.utilization > a.utilization ? b : a))]
      return shown.map((window) => ({
        id: `quota:${window.label}`,
        node: <Proportion ratio={window.utilization} label={window.label} format={entry.format ?? 'bar'} compact={compact} />,
        name: `Quota · ${window.label}`,
        value: sheetBar(window.utilization),
        detail: windowDetail(window),
        opens: 'Consommation du compte',
      }))
    }
    case 'context': {
      const ratio = data.context.used / data.context.max
      const text = `${formatTokens(data.context.used)} / ${formatTokens(data.context.max)}`
      return [{
        id: 'context',
        node: <Proportion ratio={ratio} label={compact ? undefined : 'Contexte'} text={text} format={entry.format ?? 'ring'} compact={compact} />,
        name: 'Contexte',
        value: <span className="flex items-center gap-2">{sheetBar(ratio)}<span className="text-ink-faint">{text}</span></span>,
        detail: `Contexte : ${text} tokens. La compaction approche à partir de 75 %.`,
      }]
    }
    case 'tokens': {
      const { input, output, cacheWrite, cacheRead } = data.tokens
      const total = formatTokens(input + output + cacheWrite + cacheRead)
      return [{
        id: 'tokens',
        node: <span className="tabular-nums">{total} tokens</span>,
        name: 'Tokens de la session',
        value: <span className="tabular-nums">{total}</span>,
        detail: `Entrée ${formatTokens(input)} · sortie ${formatTokens(output)} · cache écrit ${formatTokens(cacheWrite)} · cache lu ${formatTokens(cacheRead)}`,
        opens: 'Détails de la conversation',
      }]
    }
    case 'lastTurn':
      return [{
        id: 'lastTurn',
        node: <span className="tabular-nums">{compact ? '' : 'dernier tour '}{formatTokens(data.lastTurn)}</span>,
        name: 'Dernier tour',
        value: <span className="tabular-nums">{formatTokens(data.lastTurn)} tokens</span>,
        detail: 'Tokens consommés par le dernier message, cache compris. Exact, contrairement à un pourcentage de quota que les autres sessions du compte entament aussi.',
        opens: 'Page Consommation',
      }]
    case 'cost':
      return [{
        id: 'cost',
        node: <span className="tabular-nums">{data.cost.toFixed(2).replace('.', ',')} $</span>,
        name: 'Coût équivalent API',
        value: <span className="tabular-nums">{data.cost.toFixed(2).replace('.', ',')} $</span>,
        detail: 'Équivalent API calculé par le CLI. Sur un abonnement, rien n’est facturé.',
      }]
    case 'agents': {
      if (!running) return []
      return [{
        id: 'agents',
        node: (
          <span className="flex items-center gap-1 text-ink-soft">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />
            <Bot size={11} />{SUBAGENTS.length}{compact ? null : ' sous-agents'}
          </span>
        ),
        name: 'Sous-agents',
        value: `${SUBAGENTS.length} en cours`,
        detail: SUBAGENTS.map((agent) => `${agent.name} · ${agent.activity}`).join('\n'),
        opens: 'Onglet Agents du panneau',
      }]
    }
    case 'clock': {
      if (!running) return []
      return [{
        id: 'clock',
        node: <span className="flex items-center gap-1 tabular-nums"><Timer size={11} />{clockText(clock)}</span>,
        name: 'Durée du tour',
        value: <span className="tabular-nums">{clockText(clock)}</span>,
        detail: 'Depuis l’envoi du message, attentes de réponse comprises.',
      }]
    }
    case 'workTime':
      return [{
        id: 'workTime',
        node: <span className="tabular-nums">1 h 05{compact ? '' : ' de travail'}</span>,
        name: 'Temps de travail',
        value: '1 h 05',
        detail: 'Temps passé par l’agent sur cette session, sans les attentes de ta réponse.',
      }]
    case 'model':
      return [{
        id: 'model',
        node: <span className="font-mono">{data.model}</span>,
        name: 'Modèle réel',
        value: <span className="font-mono">{data.model}</span>,
        detail: 'Le modèle effectivement servi, tel que le CLI le rapporte.',
      }]
    case 'version': {
      const gap = scenario === 'limit'
      return [{
        id: 'version',
        node: <span className="flex items-center gap-1 font-mono">{gap ? <TriangleAlert size={11} className="text-caution" /> : null}v{data.version}</span>,
        name: 'Version du CLI',
        value: <span className="font-mono">v{data.version}</span>,
        detail: gap ? 'Une version plus récente est installée : elle servira au prochain lancement de la session.' : 'Version du process qui tient la session.',
      }]
    }
    case 'worktree':
      return [{
        id: 'worktree',
        node: (
          <span className={cx('flex items-center gap-1', WORKTREE_STATE_TEXT.unmerged)}>
            <GitPullRequestArrow size={11} /><span>{compact ? '3' : 'À fusionner · 3'}</span>
          </span>
        ),
        name: 'Worktree',
        value: <span className={WORKTREE_STATE_TEXT.unmerged}>À fusionner · 3 commits · PR #27</span>,
        detail: 'design/status-bar · 3 commits pas encore dans main · PR #27 ouverte',
        opens: 'Onglet Git du panneau',
      }]
    case 'files':
      return [{
        id: 'files',
        node: <span className="flex items-center gap-1 tabular-nums"><FilePen size={11} />7{compact ? null : ' fichiers'}</span>,
        name: 'Fichiers modifiés',
        value: '7 fichiers',
        detail: 'Créés, modifiés ou supprimés par cette session.',
        opens: 'Changements de la session',
      }]
    case 'tools':
      return [{
        id: 'tools',
        node: <span className="flex items-center gap-1 tabular-nums"><Wrench size={11} />84{compact ? null : ' outils'}<span className="text-critical">· 2</span></span>,
        name: 'Appels d’outils',
        value: <span>84 · <span className="text-critical">2 erreurs</span></span>,
        detail: '84 appels d’outils, dont 2 en erreur.',
      }]
    case 'previews':
      return [{
        id: 'previews',
        node: <span className="flex items-center gap-1 tabular-nums"><Globe size={11} />:5173</span>,
        name: 'Aperçus actifs',
        value: ':5173 · Maquette de la barre d’état',
        detail: 'Serveur de dev lancé par la session, ouvert dans l’onglet Aperçu.',
        opens: 'Onglet Aperçu du panneau',
      }]
    case 'shortcuts':
      if (compact) return []
      return [{
        id: 'shortcuts',
        node: <span>Entrée pour envoyer, Maj+Entrée pour un retour à la ligne</span>,
        name: 'Raccourcis',
        value: 'Entrée, Maj+Entrée',
        detail: 'Entrée pour envoyer, Maj+Entrée pour un retour à la ligne',
        end: true,
      }]
  }
}
