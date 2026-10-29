import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { Button } from './Button'
import { cx } from './cx'

/**
 * Confirmation for actions with nonobvious consequences. Explain what happens rather than merely
 * repeating the button. Obvious Close actions need none; consequential actions deserve more than
 * Are you sure.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onConfirm,
  tone = 'accent',
  busy = false,
  confirmDisabled = false,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  confirmLabel: string
  onConfirm: () => void
  /** Use critical for destructive actions so color reinforces the label. */
  tone?: 'accent' | 'critical'
  busy?: boolean
  /** The action cannot apply as things stand; the body says why. */
  confirmDisabled?: boolean
  children: ReactNode
}) {
  const t = useTranslate()
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'surface fixed top-1/2 left-1/2 z-50 w-[min(26rem,92vw)] -translate-x-1/2 -translate-y-1/2',
            'flex flex-col gap-3 rounded-lg border border-line p-4 shadow-pop',
          )}
        >
          <Dialog.Title className="text-[0.9375rem] font-semibold tracking-tight">
            {title}
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="flex flex-col gap-2 text-sm text-ink-soft">{children}</div>
          </Dialog.Description>

          <div className="mt-1 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" disabled={busy}>{t('dialog.cancel')}</Button>
            </Dialog.Close>
            <Button
              variant={tone === 'critical' ? 'danger' : 'primary'}
              busy={busy}
              disabled={confirmDisabled}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
