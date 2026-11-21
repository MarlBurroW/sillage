import { AlertTriangle, Home, RefreshCw, RotateCcw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslate } from '../lib/i18n'
import { reloadForUpdate } from '../lib/lazy-reload'
import { Button } from './ui'

/**
 * Catches a render exception below it. Without one, React unmounts the whole root: a tool view
 * meeting a payload a CLI update changed, or a lazy chunk a deployment removed, left a blank page
 * with no Stop button and nothing saying to reload. `resetKeys` clears the error when they change,
 * so navigating away from a broken page recovers on its own.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (error: Error, reset: () => void) => ReactNode; resetKeys?: readonly unknown[]; label?: string },
  { error: Error | null; keys: readonly unknown[] | undefined }
> {
  override state: { error: Error | null; keys: readonly unknown[] | undefined } = { error: null, keys: this.props.resetKeys }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(
    props: { resetKeys?: readonly unknown[] },
    state: { error: Error | null; keys: readonly unknown[] | undefined },
  ) {
    const changed = (props.resetKeys ?? []).some((key, index) => !Object.is(key, state.keys?.[index]))
    if (!changed) return null
    return { error: null, keys: props.resetKeys }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`sillage: ${this.props.label ?? 'view'} failed to render`, error, info.componentStack)
  }

  private readonly reset = () => this.setState({ error: null })

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children
  }
}

/**
 * Last resort for the whole interface. Try again first: composer drafts live in memory and survive
 * a re-render, not a reload. Reloading also asks the service worker for a newer version, since a
 * tab left open across a deployment is the usual cause.
 */
export function AppCrash({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslate()
  return (
    <div role="alert" className="flex min-h-dvh items-center justify-center bg-canvas p-6 text-ink">
      <div className="flex max-w-md flex-col gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <AlertTriangle size={18} className="text-critical" />
          {t('crash.app.title')}
        </h1>
        <p className="text-sm text-ink-soft">{t('crash.app.body')}</p>
        <CrashDetails error={error} />
        <div className="flex flex-wrap gap-2">
          <Button icon={<RotateCcw size={14} />} onClick={reset}>{t('crash.retry')}</Button>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void reloadForUpdate()}>{t('crash.reload')}</Button>
        </div>
      </div>
    </div>
  )
}

/**
 * A broken page inside the shell: navigation stays usable, and leaving the page clears it. On a
 * phone the broken page may have been the one drawing the menu button, hence a way out. Not `/`:
 * home redirects to the last conversation, often the broken one, which drew the same error again.
 */
export function PageCrash({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const project = /^\/p\/([^/]+)\//.exec(useLocation().pathname)?.[1]
  const exit = project ? `/p/${project}/board` : '/discussions/new'
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col gap-3 p-6">
      <h2 className="flex items-center gap-2 font-semibold">
        <AlertTriangle size={16} className="text-critical" />
        {t('crash.page.title')}
      </h2>
      <p className="text-sm text-ink-soft">{t('crash.page.body')}</p>
      <CrashDetails error={error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<RotateCcw size={14} />} onClick={reset}>{t('crash.retry')}</Button>
        <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void reloadForUpdate()}>{t('crash.reload')}</Button>
        <Button size="sm" variant="ghost" icon={<Home size={14} />} onClick={() => navigate(exit)}>{t('crash.home')}</Button>
      </div>
    </div>
  )
}

/** One thread element that cannot be drawn: the rest of the conversation, its composer and Stop stay. */
export function ItemCrash({ error }: { error: Error }) {
  const t = useTranslate()
  return (
    <div role="alert" className="my-1 border-l-2 border-critical/60 py-1 pl-3 text-[0.75rem] text-ink-faint">
      <span className="font-medium text-ink-soft">{t('crash.item')}</span>
      <span className="ml-2 font-mono text-[0.6875rem]">{error.message}</span>
    </div>
  )
}

function CrashDetails({ error }: { error: Error }) {
  const t = useTranslate()
  return (
    <details className="text-xs text-ink-faint">
      <summary className="cursor-pointer">{t('crash.details', { version: __APP_VERSION__ })}</summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{error.message}</pre>
    </details>
  )
}
