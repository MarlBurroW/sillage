import { useEffect, useRef } from 'react'
import { useTranslate } from '../../lib/i18n'
import { useEditorDraftPaths } from '../../lib/editor-documents'
import { useCurrentUser } from '../../lib/session'
import { restoreTreeWidth, setPanelTree, setTreeWidth, usePanelTree } from '../../lib/panel'
import { resizeHandle } from '../../lib/resize-handle'
import { useTreeSync } from '../../lib/tree'
import { Button, cx } from '../ui'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'

/**
 * Tree and editor together. Formerly separate tabs forced leaving the tree to view files, requiring
 * defensive double-clicking and feeling like nested tabs. Below NARROW_PX they cannot fit side by
 * side: overlay the tree and close it on file selection, as on fullscreen touch panels.
 */
/** Keep aligned with the 35rem min/max container-query thresholds below. */
const NARROW_PX = 560

export function FilesPane({ scope }: { scope: string }) {
  const t = useTranslate()
  const treeOpen = usePanelTree()
  const { data: user } = useCurrentUser()
  const drafts = useEditorDraftPaths(user?.id ?? '', scope)
  const host = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  useTreeSync(scope)
  useEffect(restoreTreeWidth, [])

  /**
   * Measure on click rather than continuous state: width only decides whether to close the column;
   * observation would rerender the tree every resize frame.
   */
  const closeIfOverlaid = () => {
    const width = host.current?.getBoundingClientRect().width ?? 0
    if (width < NARROW_PX) setPanelTree(false, false)
  }

  /**
   * Column starts at container left, so pointer x minus that edge is width. Remeasure on every
   * event because the parent panel resizes independently and window changes during dragging could
   * invalidate initial space.
   */
  const handle = resizeHandle({
    widthAt: (clientX) => clientX - (host.current?.getBoundingClientRect().left ?? 0),
    current: () => column.current?.getBoundingClientRect().width ?? null,
    apply: (width, persist) =>
      setTreeWidth(width, host.current?.getBoundingClientRect().width ?? 0, persist),
  })

  // Relative positioning anchors overlaid tree columns to this frame.
  return (
    <div ref={host} className="@container relative flex min-h-0 min-w-0 flex-1">
      {treeOpen ? (
        <div
          ref={column}
          className={cx(
            'min-h-0 shrink-0 overflow-auto border-r border-line py-1',
            // Place beside the editor when space permits, otherwise overlay. Add surface background
            // only when overlaid, avoiding an unexplained lighter rectangle otherwise. Clamp width
            // in CSS too for panels shrunk after dragging.
            '@min-[35rem]:w-[min(var(--tree-width,15rem),60%)]',
            '@max-[35rem]:absolute @max-[35rem]:inset-y-0 @max-[35rem]:left-0 @max-[35rem]:z-10',
            '@max-[35rem]:w-full @max-[35rem]:bg-surface @max-[35rem]:shadow-card',
          )}
        >
          {drafts.length > 0 ? <div className="px-2 py-1 @min-[35rem]:hidden">
            <Button size="sm" variant="secondary" className="w-full" onClick={() => setPanelTree(false, false)}>
              {t('editor.drafts.recover', { count: drafts.length })}
            </Button>
          </div> : null}
          <FileTree scope={scope} onOpenFile={closeIfOverlaid} />
        </div>
      ) : null}

      {/*
       * Handles only beside editors: overlays share no space and touch handles would intercept
       * scrolling mid-screen.
       */}
      {treeOpen ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('panel.tree.resize.aria')}
          tabIndex={0}
          onPointerDown={handle.onPointerDown}
          onKeyDown={handle.onKeyDown}
          className={cx(
            'relative z-10 -ml-1 w-2 shrink-0 cursor-col-resize @max-[35rem]:hidden',
            'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
            'after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent',
            'outline-none',
          )}
        />
      ) : null}

      {/*
       * min-w-0 prevents flex content sizing from forcing editor width onto the panel instead of
       * scrolling internally.
       */}
      <div className={cx('min-h-0 min-w-0 flex-1', treeOpen && '@max-[35rem]:invisible')}>
        <EditorPane scope={scope} />
      </div>
    </div>
  )
}
