import type { ComponentType } from 'react'
import { AGENT_MARKS, type AgentKind } from '@sillage/protocol'
import { translate } from '../lib/i18n'

/**
 * Marks are data shared with the server-rendered shared pages (`AGENT_MARKS`): Claude from Simple
 * Icons (CC0 1.0, the recognizable Claude logo rather than Claude Code's), OpenAI and Grok from
 * @lobehub/icons-static-svg (MIT), opencode redrawn as two rectangles on the same 24-unit grid,
 * Antigravity from its official ACP registry icon. Nominative use identifies the responding CLI;
 * Sillage is not affiliated with these vendors and never presents itself as such.
 */
function markOf(agent: AgentKind): ComponentType<{ size: number }> {
  const mark = AGENT_MARKS[agent]
  return function Mark({ size }: { size: number }) {
    return (
      <svg role="img" viewBox={mark.viewBox} width={size} height={size} fill={mark.color ?? 'currentColor'} fillRule={mark.fillRule} aria-hidden>
        {mark.paths.map((path, index) => <path key={index} d={path.d} opacity={path.opacity} />)}
      </svg>
    )
  }
}

/**
 * UI CLI metadata: label, publisher, description, and brand. Exhaustive enum table instead of
 * scattered ternaries: adding a protocol CLI without metadata fails compilation, whereas previous
 * binary logic showed OpenAI logos for any new agent. Descriptions explain real distinctions rather
 * than promotional adjectives.
 */
export interface AgentMeta {
  label: string
  vendor: string
  blurb: string
  Mark: ComponentType<{ size: number }>
}

export const AGENT_META: Record<AgentKind, AgentMeta> = {
  claude: {
    label: 'Claude Code',
    vendor: 'Anthropic',
    blurb: translate('agent.blurb.claude'),
    Mark: markOf('claude'),
  },
  codex: {
    label: 'Codex',
    vendor: 'OpenAI',
    blurb: translate('agent.blurb.codex'),
    Mark: markOf('codex'),
  },
  opencode: {
    label: 'OpenCode',
    vendor: 'Anomaly',
    blurb: translate('agent.blurb.opencode'),
    Mark: markOf('opencode'),
  },
  antigravity: { label: 'Google Antigravity', vendor: 'Google', blurb: translate('agent.blurb.antigravity'), Mark: markOf('antigravity') },
  grok: {
    label: 'Grok Build',
    vendor: 'xAI',
    blurb: translate('agent.blurb.grok'),
    Mark: markOf('grok'),
  },
}

export const AGENT_LABELS: Record<AgentKind, string> = Object.fromEntries(
  Object.entries(AGENT_META).map(([kind, meta]) => [kind, meta.label]),
) as Record<AgentKind, string>

/** Visual marker for a conversation's CLI. */
export function AgentIcon({ agent, size = 14 }: { agent: AgentKind; size?: number }) {
  const { label, Mark } = AGENT_META[agent]
  return (
    <span aria-label={label} className="inline-flex">
      <Mark size={size} />
    </span>
  )
}
