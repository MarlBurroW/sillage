import { HelpCircle } from 'lucide-react'
import { useTranslate, type MessageKey } from '../../lib/i18n'

/**
 * L'explication d'un mécanisme, repliée par défaut.
 *
 * Consignes et mémoire touchent à ce que reçoivent les agents sans qu'on le voie :
 * l'explication doit être à un clic de l'endroit où l'on agit, sans prendre la place
 * de l'éditeur pour qui la connaît déjà.
 */
export function HowItWorks({ items }: { items: MessageKey[] }) {
  const t = useTranslate()
  return (
    <details className="group rounded-md border border-line px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-ink-soft select-none hover:text-ink">
        <HelpCircle size={14} className="shrink-0 text-ink-faint" />
        {t('help.howItWorks')}
      </summary>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-ink-soft">
        {items.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </details>
  )
}

export const INSTRUCTIONS_HELP: MessageKey[] = [
  'instructions.how.injected',
  'instructions.how.sillage',
  'instructions.how.repo',
  'instructions.how.agents',
  'instructions.how.timing',
  'instructions.how.vsMemory',
]

export const MEMORY_HELP: MessageKey[] = [
  'memory.how.what',
  'memory.how.claude',
  'memory.how.codex',
  'memory.how.opencode',
  'memory.how.scope',
  'memory.how.import',
  'memory.how.edit',
]
