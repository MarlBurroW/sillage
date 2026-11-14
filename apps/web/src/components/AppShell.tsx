import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Outlet, useMatch } from 'react-router-dom'
import { useAppearanceSync } from '../lib/appearance-sync'
import { useConcentration } from '../lib/concentration'
import { useRevalidateLists } from '../lib/conversation-status'
import { useDecisionsLive } from '../lib/decisions'
import { useFileDropGuard } from '../lib/file-drop'
import { useTranslate } from '../lib/i18n'
import { useCapability } from '../lib/instance'
import { useRememberContext } from '../lib/last-context'
import { setPanelConcentration } from '../lib/panel'
import { restoreSidebarWidth } from '../lib/sidebar'
import { useMediaQuery, useVisualViewport } from '../lib/viewport'
import '../styles/concentration.css'
import '../styles/sidebar.css'
import { CommandPalette } from './CommandPalette'
import { DecisionDialog } from './decisions/DecisionDialog'
import { Logo } from './Logo'
import { MobileNavigationButton, MobileNavigationContext } from './MobileNavigation'
import { Navigation } from './nav/Navigation'
import { Toaster } from './Toaster'
import { UpdatePrompt } from './UpdatePrompt'
import { cx } from './ui'

/**
 * Desktop keeps the navigation beside the page: a rail that is always there, and a column that
 * folds. Mobile presents the same component as a full-screen drawer.
 */
export function AppShell() {
  useDecisionsLive()
  const t = useTranslate()
  useAppearanceSync()
  const [navOpen, setNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const pwa = useCapability('pwa')
  const concentration = useConcentration()
  useLayoutEffect(() => {
    setPanelConcentration(concentration)
    return () => setPanelConcentration(false)
  }, [concentration])
  const aside = useRef<HTMLElement>(null)
  const wide = useMediaQuery('(min-width: 48rem)')
  const conversationRoute = useMatch('/p/:projectId/c/:conversationId')
  const discussionRoute = useMatch('/discussions/:conversationId')
  const boardRoute = useMatch('/p/:projectId/board')
  const servicesRoute = useMatch('/services')
  const wallRoute = useMatch('/wall')
  const schedulesRoute = useMatch('/p/:projectId/schedules')
  const automationRoute = useMatch('/p/:projectId/schedules/:taskId')
  const contextualHeader = Boolean(conversationRoute || discussionRoute || boardRoute || servicesRoute || wallRoute || schedulesRoute || automationRoute)
  const navInactive = concentration || (!wide && !navOpen)
  useVisualViewport()
  useFileDropGuard()
  useRememberContext()
  const revalidateLists = useRevalidateLists()

  useEffect(restoreSidebarWidth, [])

  useEffect(() => {
    if (!wide && navOpen) revalidateLists()
  }, [wide, navOpen, revalidateLists])

  useEffect(() => {
    if (wide || !navOpen) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    aside.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      const target = previous?.isConnected && !previous.closest('[inert]')
        ? previous
        : document.querySelector<HTMLElement>('[data-navigation-trigger]')
      target?.focus()
    }
  }, [wide, navOpen])

  // Global shortcut: open the palette from any view, including while the composer has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setSearchOpen((value) => !value)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    /**
     * Fixed app layer sized by app-layer. With the keyboard open it follows the visual viewport and
     * offsets by viewport-top, moving above the keyboard instead of hiding the composer.
     */
    <MobileNavigationContext.Provider value={() => setNavOpen(true)}>
    <div className="app-layer flex overflow-hidden text-ink">
      <aside
        ref={aside}
        inert={navInactive}
        aria-hidden={navInactive}
        role={!wide && navOpen ? 'dialog' : undefined}
        aria-modal={!wide && navOpen ? true : undefined}
        aria-label={t('shell.nav.label')}
        onKeyDown={(event) => {
          const node = aside.current
          if (wide || !navOpen || event.defaultPrevented || !node?.contains(event.target as Node)) return
          if (event.key === 'Escape') {
            event.preventDefault()
            setNavOpen(false)
          }
          if (event.key !== 'Tab') return
          const targets = Array.from(node.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [tabindex]',
          )).filter((item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length > 0)
          const first = targets[0]
          const last = targets.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
        className={cx(
          // Absolute rather than fixed: reference the app layer above so the drawer follows the
          // visual viewport. Fill mobile width because a narrow drawer truncated titles after a few
          // words; nothing behind the overlay needs to remain visible.
          'absolute inset-y-0 left-0 z-30 w-full shrink-0',
          'surface border-r border-line pt-safe',
          // Transition translate rather than transform: Tailwind v4 uses the separate CSS translate
          // property, so transform transitions did nothing and mobile drawers jumped.
          'transition-[translate] duration-200 ease-out',
          // Desktop takes the width of what it shows: the rail alone, or the rail and its column.
          'md:relative md:h-full md:w-auto md:translate-x-0',
          navOpen && !concentration ? 'translate-x-0' : '-translate-x-full',
          // Concentration removes navigation entirely; its own control brings it back.
          concentration && 'md:hidden',
        )}
      >
        <Navigation
          wide={wide}
          onNavigate={() => setNavOpen(false)}
          onClose={() => setNavOpen(false)}
          onSearch={() => {
            setNavOpen(false)
            setSearchOpen(true)
          }}
        />
      </aside>

      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      {/* Mounting the prompt registers the service worker: without PWA, mount neither. */}
      {pwa ? <UpdatePrompt /> : null}

      <div
        inert={!wide && navOpen && !concentration}
        className={cx('flex min-w-0 flex-1 flex-col', contextualHeader && 'pt-safe md:pt-0')}
      >
        {!contextualHeader ? (
        <header
          className={cx(
            'header-bar flex shrink-0 items-center gap-1 px-2',
            'border-b border-line bg-canvas/85 backdrop-blur-md md:hidden',
          )}
        >
          <MobileNavigationButton />
          <Logo size={18} className="text-accent" />
          <span className="font-medium">Sillage</span>
        </header>
        ) : null}

        {/* The root layer never scrolls: views own scrolling. Supply it here for settings pages without their own. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {/* Outside the main column so decisions and toasts overlay every view including sidebar. */}
      <DecisionDialog />
      <Toaster />
    </div>
    </MobileNavigationContext.Provider>
  )
}
