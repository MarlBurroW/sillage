import { TooltipButton } from '../ui/Tooltip'
import { Check, Copy, Download, WrapText } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useCopy } from '../../lib/clipboard'
import { downloadText } from '../../lib/download'
import { translate, useTranslate } from '../../lib/i18n'
import { cx } from '../ui'
import { HighlightedCode } from './HighlightedCode'

/**
 * Download extensions by language. Language IDs differ from extensions, such as python to py; list
 * only differences and otherwise use the language name.
 */
const EXTENSIONS: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  markdown: 'md',
  bash: 'sh',
  shell: 'sh',
  rust: 'rs',
  ruby: 'rb',
  kotlin: 'kt',
  yaml: 'yml',
  plaintext: 'txt',
  dockerfile: 'Dockerfile',
}

function filenameFor(language: string): string {
  if (!language) return translate('code.filename.default')
  const extension = EXTENSIONS[language] ?? language
  return extension === 'Dockerfile' ? 'Dockerfile' : translate('code.filename', { extension })
}

export function ToolbarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        'flex size-6 shrink-0 items-center justify-center rounded transition-colors',
        active ? 'bg-accent-wash text-ink' : 'text-ink-faint hover:bg-surface-high hover:text-ink',
      )}
    >
      {children}
    </TooltipButton>
  )
}

/**
 * Code block with highlighting, wrapping, copy, and download. Wrapping is per block: long shell
 * commands benefit while aligned data tables prefer horizontal scrolling.
 */
export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [wrap, setWrap] = useState(false)
  const { state, copy } = useCopy()
  const t = useTranslate()

  return (
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink-faint">
          {language || t('code.language.plain')}
        </span>

        <ToolbarButton
          label={wrap ? t('code.wrap.disable') : t('code.wrap.enable')}
          active={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <WrapText size={13} />
        </ToolbarButton>
        <ToolbarButton
          label={t('code.download')}
          onClick={() => downloadText(filenameFor(language), code, 'text/plain')}
        >
          <Download size={13} />
        </ToolbarButton>
        <ToolbarButton
          label={state === 'failed' ? t('code.copy.failed') : t('code.copy')}
          onClick={() => copy(code)}
        >
          {state === 'copied' ? (
            <Check size={13} className="text-positive" />
          ) : (
            <Copy size={13} className={state === 'failed' ? 'text-critical' : undefined} />
          )}
        </ToolbarButton>
      </div>

      <HighlightedCode
        code={code}
        language={language}
        wrap={wrap}
        className="p-3 font-mono text-[0.8125rem] leading-relaxed"
      />
    </div>
  )
}
