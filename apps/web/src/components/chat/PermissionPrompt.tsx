import { ShieldQuestion } from 'lucide-react'
import { useState } from 'react'
import type { PermissionItem } from '../../lib/chat-fold'
import { decidePermission } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { Badge, Button, cx } from '../ui'
import { HighlightedCode } from './HighlightedCode'

export function PermissionPrompt({
  conversationId,
  permission,
  canDecide,
}: {
  conversationId: string
  permission: PermissionItem
  canDecide: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useTranslate()

  const STATUS_LABEL: Record<Exclude<PermissionItem['status'], 'pending'>, string> = {
    allowed: t('permission.status.allowed'),
    denied: t('permission.status.denied'),
    expired: t('permission.status.expired'),
  }

  const decide = async (decision: 'allowed' | 'denied', scope: 'once' | 'session') => {
    setBusy(true)
    setError(null)
    try {
      await decidePermission(conversationId, permission.id, decision, scope)
    } catch (err) {
      // L'événement `permission.resolved` viendra du serveur : on n'anticipe pas
      // l'état ici, sinon l'affichage cesserait d'être un pur fold du journal.
      setError(err instanceof Error ? err.message : t('permission.error.generic'))
      setBusy(false)
    }
  }

  const summary = summarizeInput(permission.input)

  return (
    <div
      className={cx(
        'rounded-lg border p-3',
        permission.status === 'pending'
          ? 'border-accent bg-accent-wash/40 shadow-card'
          : 'border-line bg-surface/60',
      )}
    >
      <div className="flex items-start gap-2.5">
        <ShieldQuestion size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          {/* Le titre du CLI décrit l'action et sa raison ; le repli reconstruit une
              phrase à partir du seul nom de l'outil, faute de mieux. */}
          <p className="text-sm font-medium">
            {permission.title ??
              (permission.status === 'pending'
                ? t('permission.title.pending', { tool: permission.toolName })
                : t('permission.title.past', { tool: permission.toolName }))}
          </p>
          {permission.description ? (
            <p className="mt-0.5 text-xs text-ink-soft">{permission.description}</p>
          ) : null}
          {summary ? (
            <HighlightedCode
              code={summary.content}
              language={summary.language}
              wrap
              className="mt-1.5 max-h-40 overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-xs"
            />
          ) : null}
        </div>
        {permission.status !== 'pending' ? (
          <Badge tone={permission.status === 'allowed' ? 'positive' : 'neutral'}>
            {STATUS_LABEL[permission.status]}
          </Badge>
        ) : null}
      </div>

      {permission.status === 'pending' && canDecide ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void decide('allowed', 'once')}>
            {t('permission.allow')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void decide('allowed', 'session')}
          >
            {t('permission.allowSession')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => void decide('denied', 'once')}
          >
            {t('permission.deny')}
          </Button>
        </div>
      ) : null}

      {permission.status === 'pending' && !canDecide ? (
        <p className="mt-2 text-xs text-ink-faint">{t('permission.ownerOnly')}</p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-critical">{error}</p> : null}
    </div>
  )
}

/**
 * Ce qui identifie réellement l'appel : la commande, le chemin, l'URL. À défaut, l'entrée
 * complète en JSON. Le langage suit, pour ne pas colorer une commande comme du JSON.
 */
function summarizeInput(input: unknown): { content: string; language: string } | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') return { content: input, language: '' }

  const fields = input as Record<string, unknown>
  if (typeof fields.command === 'string' && fields.command.length > 0) {
    return { content: fields.command, language: 'bash' }
  }
  for (const key of ['file_path', 'path', 'url']) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) return { content: value, language: '' }
  }
  return { content: JSON.stringify(input, null, 2), language: 'json' }
}
