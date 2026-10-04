import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { skillNameSchema } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { Button, Field, IconButton } from '../ui'

/**
 * Coque des petits formulaires de la bibliothèque : créer, dupliquer, déplacer,
 * renommer à l'import. Même présentation que la création de carte, en feuille au
 * doigt et centrée ailleurs.
 */
export function SkillDialog({
  open,
  onClose,
  title,
  submitLabel,
  busy,
  canSubmit = true,
  onSubmit,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  submitLabel: string
  busy: boolean
  canSubmit?: boolean
  onSubmit: () => void
  children: ReactNode
}) {
  const t = useTranslate()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSubmit && !busy) onSubmit()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[95dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(560px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <IconButton label={t('skills.dialog.close')} disabled={busy} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>
          <form className="flex min-h-0 flex-col" onSubmit={submit}>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">{children}</div>
            <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                {t('skills.dialog.cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmit || busy}>
                {submitLabel}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Zone de texte au gabarit des champs, pour la description d'un skill. */
export function DescriptionField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-soft">{label}</span>
      <textarea
        value={value}
        disabled={disabled}
        rows={3}
        maxLength={1024}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-20 w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint hover:border-line-strong focus:border-accent disabled:opacity-60"
      />
      <span className="text-xs text-ink-faint">{hint}</span>
    </label>
  )
}

/** Le nom est aussi celui du dossier et de la commande : minuscules, chiffres, tirets. */
export function NameField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const t = useTranslate()
  const invalid = value.length > 0 && !skillNameSchema.safeParse(value).success
  return (
    <Field
      label={t('skills.field.name')}
      hint={t('skills.field.name.hint')}
      error={invalid ? t('skills.field.name.invalid') : undefined}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      className="font-mono"
    />
  )
}
