import { conversationPath, type BrowserDto } from '@sillage/protocol'
import { Eye, Globe, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useCloseBrowser } from '../../lib/browsers'
import { useTranslate } from '../../lib/i18n'
import { showBrowser } from '../../lib/panel'
import { useProjects } from '../../lib/projects'
import { Badge, Banner, EmptyState, IconButton } from '../ui'

/** Every open agent browser: where it came from, what it shows, and a way to watch or close it. */
export function BrowsersList({ browsers }: { browsers: BrowserDto[] }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const close = useCloseBrowser()
  const { data: projects = [] } = useProjects()

  if (browsers.length === 0) {
    return <EmptyState icon={<Globe size={22} />} title={t('browsers.empty.title')} description={t('browsers.empty.description')} />
  }

  return (
    <div className="flex flex-col gap-3">
      {close.error ? <Banner>{close.error.message}</Banner> : null}
      <ul className="flex flex-col gap-2">
        {browsers.map((browser) => {
          const tab = browser.tabs.find((entry) => entry.targetId === browser.activeTargetId) ?? browser.tabs[0]
          const project = projects.find((entry) => entry.id === browser.projectId)
          const open = () => {
            navigate(conversationPath({ projectId: browser.projectId, id: browser.conversationId }))
            showBrowser()
          }
          return (
            <li key={browser.conversationId} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
              <Globe size={16} className="shrink-0 text-ink-faint" />
              <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium hover:text-accent">{tab?.title || tab?.url || t('browsers.blank')}</span>
                <span className="block truncate text-xs text-ink-faint">
                  {[project?.name, browser.conversationTitle || t('services.conversation')].filter(Boolean).join(' · ')}
                </span>
                {tab?.url ? <span className="block truncate font-mono text-[11px] text-ink-faint">{tab.url}</span> : null}
              </button>
              <div className="hidden shrink-0 items-center gap-2 sm:flex">
                {browser.tabs.length > 1 ? <Badge>{t('browsers.tabs', { count: browser.tabs.length })}</Badge> : null}
                <Badge tone={browser.agentConnected ? 'accent' : undefined}>{t(browser.agentConnected ? 'browsers.agent.active' : 'browsers.agent.idle')}</Badge>
              </div>
              <IconButton label={t('browsers.watch')} onClick={open}><Eye size={16} /></IconButton>
              <IconButton label={t('browser.close')} disabled={close.isPending} onClick={() => close.mutate(browser.conversationId)}><X size={16} /></IconButton>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
