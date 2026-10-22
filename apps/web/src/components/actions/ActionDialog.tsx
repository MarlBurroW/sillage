import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import {
  MAX_ACTION_COMMAND_CHARS,
  MAX_ACTION_DESCRIPTION_CHARS,
  MAX_ACTION_LABEL_CHARS,
  MAX_ACTION_SUBDIR_CHARS,
  MAX_ACTION_URL_CHARS,
  actionSubdirSchema,
  actionUrlSchema,
  type ProjectActionDto,
  type ProjectActionKind,
} from '@sillage/protocol'
import { useCreateAction, useUpdateAction } from '../../lib/actions'
import { useTranslate } from '../../lib/i18n'
import { Banner, Button, Field, IconButton, cx } from '../ui'

/** Create/edit actions. Saving counts as review: agent proposals edited by users become approved. */
export function ActionDialog({
  projectId,
  action,
  onClose,
}: {
  projectId: string
  /** Absent during creation. */
  action?: ProjectActionDto
  onClose: () => void
}) {
  const t = useTranslate()
  const create = useCreateAction(projectId)
  const update = useUpdateAction()
  const mutation = action ? update : create
  const commandId = useId()

  const [label, setLabel] = useState(action?.label ?? '')
  const [kind, setKind] = useState<ProjectActionKind>(action?.kind ?? 'task')
  const [command, setCommand] = useState(action?.command ?? '')
  const [description, setDescription] = useState(action?.description ?? '')
  const [subdir, setSubdir] = useState(action?.subdir ?? '')
  const [url, setUrl] = useState(action?.url ?? '')

  const subdirValid = actionSubdirSchema.safeParse(subdir).success
  const urlValid = actionUrlSchema.safeParse(url).success
  const valid = label.trim() !== '' && command.trim() !== '' && subdirValid && (kind !== 'service' || urlValid)

  const submit = () => {
    if (!valid) return
    // Tasks have no URL: switching from service removes it.
    const body = { label, kind, command, description, subdir, url: kind === 'service' ? url : '' }
    if (action) update.mutate({ id: action.id, ...body }, { onSuccess: onClose })
    else create.mutate(body, { onSuccess: onClose })
  }

  const kinds: { value: ProjectActionKind; label: string; hint: string }[] = [
    { value: 'task', label: t('actions.kind.task'), hint: t('actions.kind.taskHint') },
    { value: 'service', label: t('actions.kind.service'), hint: t('actions.kind.serviceHint') },
  ]

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !mutation.isPending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[95dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(560px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">
              {t(action ? 'actions.form.editTitle' : 'actions.form.createTitle')}
            </Dialog.Title>
            <IconButton label={t('common.close')} disabled={mutation.isPending} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>

          <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); submit() }}>
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
              <Field
                label={t('actions.form.label')}
                placeholder={t('actions.form.labelPlaceholder')}
                maxLength={MAX_ACTION_LABEL_CHARS}
                value={label}
                autoFocus={!action}
                onChange={(event) => setLabel(event.target.value)}
              />

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 text-sm font-medium text-ink-soft">{t('actions.form.kind')}</legend>
                <div role="radiogroup" aria-label={t('actions.form.kind')} className="flex gap-1 rounded-md border border-line bg-sunken p-1">
                  {kinds.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      role="radio"
                      aria-checked={kind === entry.value}
                      onClick={() => setKind(entry.value)}
                      className={cx(
                        'min-h-9 flex-1 rounded px-2 text-sm transition-colors',
                        kind === entry.value ? 'bg-surface-high font-medium text-ink' : 'text-ink-faint hover:text-ink-soft',
                      )}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-ink-faint">{kinds.find((entry) => entry.value === kind)?.hint}</p>
              </fieldset>

              <div className="flex flex-col gap-1.5">
                <label htmlFor={commandId} className="text-sm font-medium text-ink-soft">
                  {t('actions.form.command')}
                </label>
                <textarea
                  id={commandId}
                  rows={3}
                  spellCheck={false}
                  maxLength={MAX_ACTION_COMMAND_CHARS}
                  value={command}
                  placeholder={kind === 'service' ? 'pnpm dev' : 'pnpm test'}
                  onChange={(event) => setCommand(event.target.value)}
                  className="rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[0.8125rem] text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
                />
                <p className="text-xs text-ink-faint">{t('actions.form.commandHint')}</p>
              </div>

              <Field
                label={t('actions.form.subdir')}
                placeholder="apps/web"
                hint={t('actions.form.subdirHint')}
                error={subdirValid ? undefined : t('actions.form.subdirInvalid')}
                maxLength={MAX_ACTION_SUBDIR_CHARS}
                spellCheck={false}
                value={subdir}
                onChange={(event) => setSubdir(event.target.value)}
              />

              {kind === 'service' ? (
                <Field
                  label={t('actions.form.url')}
                  placeholder="http://localhost:{port}"
                  hint={t('actions.form.urlHint')}
                  error={urlValid ? undefined : t('actions.form.urlInvalid')}
                  maxLength={MAX_ACTION_URL_CHARS}
                  spellCheck={false}
                  inputMode="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              ) : null}

              <Field
                label={t('actions.form.description')}
                placeholder={t('actions.form.descriptionPlaceholder')}
                maxLength={MAX_ACTION_DESCRIPTION_CHARS}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />

              {mutation.isError ? <Banner>{mutation.error.message}</Banner> : null}
            </div>

            <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!valid || mutation.isPending}>
                {t(action ? 'actions.form.save' : 'actions.form.create')}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
