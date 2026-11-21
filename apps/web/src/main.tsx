import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from './components/ui/Tooltip'
import { DesktopTitleBar } from './components/DesktopTitleBar'
import { App } from './App'
import { AppCrash, ErrorBoundary } from './components/ErrorBoundary'
import { initLocale } from './lib/i18n'
import { reloadOnPreloadError } from './lib/lazy-reload'
import { watchThemeColor } from './lib/theme'
import './styles/index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
})

if (window.sillageDesktop?.window) document.documentElement.dataset.desktopChrome = window.sillageDesktop.window.platform
watchThemeColor()
reloadOnPreloadError()

const container = document.getElementById('root')
if (!container) throw new Error('Élément #root absent du document.')

// Load the selected language catalog before first render to avoid flashing English during download.
// `initLocale` never rejects (English fallback); using `then` rather than top-level await avoids
// requiring that syntax from target browsers.
void initLocale().then(() => {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary label="interface" fallback={(error, reset) => <AppCrash error={error} reset={reset} />}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider><DesktopTitleBar /><App /></TooltipProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
})
