import { MobileNavigationButton } from '../components/MobileNavigation'
import { ProjectMemory } from '../components/instructions/ProjectMemory'
import { useTranslate } from '../lib/i18n'

export function PersonalMemoryPage() {
  const t = useTranslate()
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <header className="flex items-center gap-3 border-b border-line p-3"><MobileNavigationButton /><h1 className="text-sm font-semibold">{t('discussions.memory')}</h1></header>
    <div className="mx-auto max-w-3xl p-4 md:p-8"><ProjectMemory projectId={null} /></div>
  </div>
}
