import { Globe } from 'lucide-react'
import { useBrowsers } from '../../lib/browsers'
import { useTranslate } from '../../lib/i18n'
import { showBrowser } from '../../lib/panel'

/**
 * Thread-bottom reminder that this conversation has a browser open, whoever opened it. Tool-call
 * shortcuts fold away with their group and miss browsers driven outside the thread (a sub-agent,
 * a script); this line stays until the browser closes.
 */
export function BrowserActivity({ conversationId }: { conversationId: string }) {
  const t = useTranslate()
  const { data: browsers } = useBrowsers()
  const browser = browsers?.find((entry) => entry.conversationId === conversationId)
  if (!browser) return null
  const tab = browser.tabs.find((entry) => entry.targetId === browser.activeTargetId) ?? browser.tabs[0]
  let place = tab?.title || ''
  if (!place && tab?.url) {
    try { place = new URL(tab.url).host } catch { place = tab.url }
  }
  return (
    <button
      type="button"
      onClick={() => showBrowser()}
      data-browser-activity
      className="group flex max-w-full items-center gap-2 self-start py-1 text-left text-xs text-ink-faint hover:text-accent"
    >
      <Globe size={13} className="shrink-0 text-accent" />
      <span className="shrink-0 font-medium">{t(browser.agentConnected ? 'browser.activity.agent' : 'browser.activity.open')}</span>
      {place ? <span className="min-w-0 truncate">· {place}</span> : null}
      <span className="shrink-0 text-accent underline-offset-2 group-hover:underline">{t('browser.activity.watch')}</span>
    </button>
  )
}
