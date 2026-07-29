import { CircleAlert, CircleCheck, KeyRound, Loader, Plug, PlugZap } from 'lucide-react'
import type { ReactNode } from 'react'
import type { McpServerState, McpServerStatus } from '@sillage/protocol'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { Badge, EmptyState } from '../ui'

/**
 * Les serveurs MCP de la session, tels que le CLI les rapporte.
 *
 * Interrogés au CLI et non déduits de ce que Sillage a transmis : c'est la seule
 * surface qui peut dire qu'un serveur a échoué à démarrer. Sans elle, un serveur mal
 * configuré est indiscernable d'un modèle qui a choisi de ne pas s'en servir.
 *
 * Les serveurs venus de la configuration du CLI y figurent aussi, marqués comme tels :
 * l'utilisateur les subit au même titre que les siens, et il vaut mieux qu'il sache
 * d'où ils viennent que de les voir apparaître sans explication.
 */

const STATE_ICONS: Record<McpServerState, ReactNode> = {
  pending: <Loader size={13} />,
  connected: <CircleCheck size={13} />,
  failed: <CircleAlert size={13} />,
  'needs-auth': <KeyRound size={13} />,
  disabled: <Plug size={13} />,
}

const STATE_LABELS: Record<McpServerState, MessageKey> = {
  pending: 'panel.mcp.state.pending',
  connected: 'panel.mcp.state.connected',
  failed: 'panel.mcp.state.failed',
  'needs-auth': 'panel.mcp.state.needsAuth',
  disabled: 'panel.mcp.state.disabled',
}

/** Seuls l'échec et l'authentification manquante appellent l'oeil. */
const STATE_TONES: Record<McpServerState, string> = {
  pending: 'text-ink-faint',
  connected: 'text-accent',
  failed: 'text-critical',
  'needs-auth': 'text-caution',
  disabled: 'text-ink-faint',
}

export function McpPane({ servers }: { servers: McpServerStatus[] }) {
  const t = useTranslate()

  if (servers.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center p-4">
        <EmptyState
          icon={<PlugZap size={22} />}
          title={t('panel.mcp.empty.title')}
          description={t('panel.mcp.empty.description')}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      {servers.map((server) => (
        <div
          key={server.name}
          className="flex items-center gap-2 rounded-md border border-line bg-surface-high px-2 py-1.5"
        >
          <span className={`shrink-0 ${STATE_TONES[server.state]}`}>
            {STATE_ICONS[server.state]}
          </span>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-ink">{server.name}</span>
            <span className="block truncate text-[0.6875rem] text-ink-faint">
              {/* L'erreur remplace l'état : quand un serveur échoue, sa raison vaut
                  mieux que le mot « en échec », déjà porté par l'icône. */}
              {server.error ?? t(STATE_LABELS[server.state])}
            </span>
          </span>

          {server.external ? (
            <Badge>{t('panel.mcp.external')}</Badge>
          ) : null}

          {server.tools.length > 0 ? (
            <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
              {t(server.tools.length > 1 ? 'panel.mcp.tools.many' : 'panel.mcp.tools.one', {
                count: server.tools.length,
              })}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
