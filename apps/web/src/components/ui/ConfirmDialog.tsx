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
  size = 'default',
  showCancel = true,
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
  /** Wide holds a list: the body scrolls, and the dialog fills the screen on phones. */
  size?: 'default' | 'wide'
  /** Hide Cancel once there is nothing left to cancel, such as on a result summary. */
  showCancel?: boolean
  children: ReactNode
}) {
  const t = useTranslate()
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'surface fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'flex flex-col gap-3 rounded-lg border border-line p-4 shadow-pop',
            size === 'wide'
              ? cx(
                  'max-h-[90dvh] w-[min(38rem,94vw)]',
                  'max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0',
                )
              : 'w-[min(26rem,92vw)]',
          )}
        >
          <Dialog.Title className="text-[0.9375rem] font-semibold tracking-tight">
            {title}
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className={cx('flex flex-col gap-2 text-sm text-ink-soft', size === 'wide' && 'min-h-0 flex-1 overflow-y-auto')}>{children}</div>
          </Dialog.Description>

          <div className="mt-1 flex justify-end gap-2">
            {showCancel ? (
              <Dialog.Close asChild>
                <Button variant="ghost" disabled={busy}>{t('dialog.cancel')}</Button>
              </Dialog.Close>
            ) : null}
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
