import { ChevronDown, Mic, Paperclip, Plus } from 'lucide-react'
import { useRef, type RefObject } from 'react'
import { useTranslate } from '../../lib/i18n'
import { SettingsSurface } from './ComposerSettings'
import { TooltipButton } from '../ui/Tooltip'
import { toolButtonClass } from './composer-buttons'
import { SettingsHeading } from './SettingsPanel'

export type ComposerPrefix = '@' | '@@' | '#' | '/' | '$'

/** Prefixes this composer can open, in menu order, as the trigger below the field shows them. */
export function composerPrefixes({ project, commands, skills }: { project: boolean; commands: boolean; skills: boolean }): ComposerPrefix[] {
  return [...(project ? ['@', '@@', '#'] as const : []), ...(commands ? ['/'] as const : []), ...(skills ? ['$'] as const : [])]
}

/**
 * Empty-field text. Short: the shortcuts trigger right below the field already names the prefixes,
 * and spelling them out again ran the placeholder past the field's width.
 */
export function useComposerPlaceholder({ disabled }: { disabled: boolean }): string {
  const t = useTranslate()
  return disabled ? t('composer.placeholder.readonly') : t('composer.placeholder.write')
}

/** Teach the same prefixes that typing opens; selecting a row only starts completion. */
export function ComposerInsert({ inputRef, disabled, project, commands, skills, combinedCommands, onInsert, compact = false, glyphsOnly = false, onAttach, onDictate }: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
  project: boolean
  commands: boolean
  skills: boolean
  combinedCommands: boolean
  onInsert: (prefix: ComposerPrefix) => void
  compact?: boolean
  /** Phones: the glyphs alone, leaving the status line beside it room for more than one item. */
  glyphsOnly?: boolean
  onAttach?: () => void
  onDictate?: () => void
}) {
  const t = useTranslate()
  const pending = useRef<(() => void) | null>(null)
  const entries: { prefix: ComposerPrefix; label: string; hint: string }[] = [
    ...(project ? [
      { prefix: '@' as const, label: t('composer.insert.file'), hint: t('composer.insert.fileHint') },
      { prefix: '@@' as const, label: t('composer.insert.session'), hint: t('composer.insert.sessionHint') },
      { prefix: '#' as const, label: t('composer.insert.card'), hint: t('composer.insert.cardHint') },
    ] : []),
    ...(commands ? [{ prefix: '/' as const, label: t(combinedCommands ? 'composer.insert.commandsSkills' : 'composer.insert.command'), hint: t('composer.insert.commandHint') }] : []),
    ...(skills ? [{ prefix: '$' as const, label: t('composer.insert.skill'), hint: t('composer.insert.skillHint') }] : []),
  ]

  return (
    <SettingsSurface label={t('composer.insert.title')} inputRef={inputRef} disabled={disabled} quick
      onCloseAutoFocus={(event) => {
        const action = pending.current
        pending.current = null
        if (!action) return
        // Wait for the modal focus trap to unmount before focusing the field, including on touch.
        event.preventDefault()
        action()
      }}
      trigger={compact ? (
        <TooltipButton type="button" disabled={disabled} aria-label={t('concentration.add')} title={t('concentration.add')}
          className={toolButtonClass(false)}><Plus size={18} /></TooltipButton>
      ) : (
        <button type="button" disabled={disabled} aria-label={t('composer.insert.label')}
          className="mt-1 flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-ink-soft hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-surface-high disabled:opacity-45 pointer-coarse:min-h-11"
        >
          {/* The glyphs make the button read as "the thing behind @ and /" rather than a generic insert. */}
          {composerPrefixes({ project, commands, skills }).filter((prefix) => prefix !== '$' && prefix !== '@@').map((prefix) => (
            <code key={prefix} aria-hidden className="rounded border border-line bg-surface-high px-1 font-mono text-[0.6875rem] leading-4 text-ink">{prefix}</code>
          ))}
          {glyphsOnly ? null : <span className="ml-0.5">{t('composer.insert.trigger')}</span>}<ChevronDown size={12} aria-hidden />
        </button>
      )}
    >
      {(close) => <>
        <SettingsHeading title={t('composer.insert.title')} onClose={() => close()} />
        <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-[max(0.5rem,var(--sg-safe-bottom))]">
          <p className="px-2 pb-2 text-xs leading-relaxed text-ink-soft">{t('composer.insert.hint')}</p>
          {compact ? <div className="mb-2 border-b border-line pb-2">
            {[
              { action: onAttach, label: t('composer.attach.label'), icon: <Paperclip size={17} /> },
              { action: onDictate, label: t('composer.dictate.start'), icon: <Mic size={17} /> },
            ].filter((entry) => entry.action).map(({ action, label, icon }) => (
              <button key={label} type="button" onClick={() => { pending.current = action!; close() }}
                className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-accent">
                {icon}{label}
              </button>
            ))}
          </div> : null}
          {entries.map(({ prefix, label, hint }) => (
            <button key={prefix} type="button" aria-label={label} onClick={() => { pending.current = () => onInsert(prefix); close() }}
              className="flex w-full items-start gap-3 rounded-md px-2 py-2.5 text-left hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-accent"
            >
              <code aria-hidden className="mt-0.5 flex h-7 w-9 shrink-0 items-center justify-center rounded border border-line bg-surface-high text-sm text-ink">{prefix}</code>
              <span className="min-w-0"><span className="block text-sm font-medium text-ink">{label}</span><span className="mt-0.5 block text-xs leading-relaxed text-ink-soft">{hint}</span></span>
            </button>
          ))}
          <p className="mt-2 border-t border-line px-2 pt-3 pb-2 text-xs leading-relaxed text-ink-faint">{t('composer.insert.catalogHint')}</p>
          <p className="px-2 pb-2 text-xs leading-relaxed text-ink-faint">{t('composer.insert.historyHint')}</p>
        </div>
      </>}
    </SettingsSurface>
  )
}
