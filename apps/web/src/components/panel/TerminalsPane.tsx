import { Loader, Plus, SquareTerminal as TerminalIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MAX_TERMINALS_PER_CONVERSATION } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { useCloseTerminal, useOpenTerminal, useTerminals } from '../../lib/terminals'
import { Banner, Button, cx } from '../ui'
import { TerminalView } from './TerminalView'

/**
 * Onglets de terminaux, et le terminal actif en dessous.
 *
 * Les vues restent toutes montées : une commande qui tourne dans l'un ne doit pas être
 * coupée parce qu'on regarde l'autre, et remonter un terminal repartirait d'un écran
 * vide alors que le pty, lui, a continué.
 */
export function TerminalsPane({
  conversationId,
  visible,
}: {
  conversationId: string
  visible: boolean
}) {
  const { data: terminals, error, isPending } = useTerminals(conversationId, visible)
  const open = useOpenTerminal(conversationId)
  const close = useCloseTerminal(conversationId)
  const [active, setActive] = useState<string | null>(null)
  const t = useTranslate()

  // La sélection suit la liste : un terminal fermé, ou une liste vidée par un
  // redémarrage du daemon, ne doit pas laisser une vue pointant sur rien.
  useEffect(() => {
    if (!terminals) return
    setActive((current) =>
      current && terminals.some((terminal) => terminal.id === current)
        ? current
        : (terminals[0]?.id ?? null),
    )
  }, [terminals])

  const full = (terminals?.length ?? 0) >= MAX_TERMINALS_PER_CONVERSATION

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-px overflow-x-auto border-b border-line">
        {(terminals ?? []).map((terminal) => (
          <div
            key={terminal.id}
            className={cx(
              'group/term flex h-8 shrink-0 items-center gap-1 border-r border-line pr-1 pl-2.5',
              terminal.id === active ? 'bg-surface text-ink' : 'bg-sunken text-ink-faint',
            )}
          >
            <button type="button" onClick={() => setActive(terminal.id)} className="text-xs">
              {terminal.title}
            </button>
            {/* Vivant ou terminé : sans ce repère, un onglet dont le shell est mort
                ressemble à un onglet inactif. */}
            <span
              aria-label={terminal.alive ? t('terminal.tab.shellAlive') : t('terminal.tab.shellDone')}
              className={cx(
                'size-1.5 shrink-0 rounded-full',
                terminal.alive ? 'bg-positive' : 'bg-ink-faint/50',
              )}
            />
            <button
              type="button"
              onClick={() => close.mutate(terminal.id)}
              aria-label={t('terminal.tab.close', { title: terminal.title })}
              className="rounded p-0.5 text-ink-faint opacity-0 hover:text-ink group-hover/term:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        ))}

        <button
          type="button"
          // Le nouveau terminal devient l'actif : cliquer sur « + » sans rien voir
          // changer donne l'impression que rien ne s'est passé.
          onClick={() => open.mutate(undefined, { onSuccess: (created) => setActive(created.id) })}
          disabled={full || open.isPending}
          aria-label={t('terminal.new')}
          title={
            full
              ? t('terminal.max', { max: MAX_TERMINALS_PER_CONVERSATION })
              : t('terminal.new')
          }
          className="flex size-8 shrink-0 items-center justify-center text-ink-faint hover:text-ink disabled:opacity-40"
        >
          {open.isPending ? <Loader size={13} className="animate-spin" /> : <Plus size={14} />}
        </button>
      </div>

      {error || open.error || close.error ? (
        <div className="p-2">
          <Banner>
            {(error ?? open.error ?? close.error) instanceof Error
              ? (error ?? open.error ?? close.error)?.message
              : t('terminal.unavailable')}
          </Banner>
        </div>
      ) : null}

      {isPending ? (
        <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink-faint">
          <Loader size={11} className="animate-spin" />
          {t('terminal.loading')}
        </p>
      ) : null}

      {terminals?.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="grid size-12 place-items-center rounded-xl border border-line bg-surface-high text-ink-faint">
            <TerminalIcon size={22} />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-ink">{t('terminal.empty.title')}</p>
            <p className="max-w-[22rem] text-xs text-ink-faint">
              {t('terminal.empty.description')}
            </p>
          </div>
          <Button
            size="sm"
            disabled={open.isPending}
            onClick={() => open.mutate(undefined, { onSuccess: (created) => setActive(created.id) })}
          >
            {open.isPending ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            {t('terminal.new')}
          </Button>
        </div>
      ) : null}

      {(terminals ?? []).map((terminal) => (
        <div
          key={terminal.id}
          className={cx(
            'min-h-0 min-w-0 flex-1',
            terminal.id === active && visible ? 'block' : 'hidden',
          )}
        >
          <TerminalView
            conversationId={conversationId}
            terminalId={terminal.id}
            visible={terminal.id === active && visible}
          />
        </div>
      ))}
    </div>
  )
}
