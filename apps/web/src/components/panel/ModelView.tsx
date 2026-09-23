import { Grid3x3, Loader, Maximize2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import { ModelViewer, type ModelStats } from '../../lib/model-viewer'
import type { WorkspaceScope } from '../../lib/workspace-scope'
import { Banner, Button, IconButton } from '../ui'

/**
 * Modèle 3D du workspace, dans une scène WebGL. Chargé à la demande par l'éditeur :
 * ce composant entraîne `three` avec lui.
 */
export function ModelView({ scope, path }: { scope: WorkspaceScope; path: string }) {
  const host = useRef<HTMLDivElement>(null)
  const viewer = useRef<ModelViewer | null>(null)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; stats: ModelStats } | { status: 'error'; message: string }>({ status: 'loading' })
  const [grid, setGrid] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const t = useTranslate()

  useEffect(() => {
    const node = host.current
    if (!node) return
    let instance: ModelViewer
    try {
      instance = new ModelViewer(node, scope, path)
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    viewer.current = instance
    setState({ status: 'loading' })
    instance.load().then(
      (stats) => setState({ status: 'ready', stats }),
      (error: unknown) => {
        if (error instanceof Error && error.message === 'disposed') return
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      viewer.current = null
      instance.dispose()
    }
  }, [scope, path, attempt])

  useEffect(() => { viewer.current?.setGrid(grid) }, [grid])

  return (
    <div data-editor-file={path} tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
      <div className="relative min-h-0 min-w-0 flex-1 bg-canvas">
        <div ref={host} className="absolute inset-0 overflow-hidden" />
        {state.status === 'loading' ? <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-ink-faint">
          <Loader size={20} className="animate-spin" aria-label={t('editor.model.loading')} />
        </div> : null}
        {state.status === 'error' ? <div className="absolute inset-x-0 top-0 p-3">
          <Banner>{t('editor.model.error')} {state.message}</Banner>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setAttempt((n) => n + 1)}>{t('editor.retry')}</Button>
        </div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-2.5 py-1.5 text-xs text-ink-faint">
        <span className="min-w-0 flex-1 truncate" title={path}>{path}</span>
        {state.status === 'ready' ? <span className="shrink-0">{t('editor.model.stats', { ...state.stats })}</span> : null}
        <IconButton size="sm" label={t('editor.model.fit')} disabled={state.status !== 'ready'} onClick={() => viewer.current?.fit()}><Maximize2 size={14} /></IconButton>
        <IconButton size="sm" label={t(grid ? 'editor.model.gridHide' : 'editor.model.gridShow')} aria-pressed={grid} className={grid ? 'text-ink' : undefined} onClick={() => setGrid((value) => !value)}><Grid3x3 size={14} /></IconButton>
      </div>
    </div>
  )
}
