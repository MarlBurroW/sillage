import { useContext, useMemo, useState, type MouseEvent } from 'react'
import { useCardRefs } from '../../lib/card-refs'
import { openTab } from '../../lib/editor-tabs'
import { FileLinkContext, useKnownFiles } from '../../lib/file-links'
import { parseMarkdown } from '../../lib/markdown'
import { setPanelOpen, setPanelTab } from '../../lib/panel'
import { useCardRefPreview } from '../board/CardRefPreview'
import { CodeBlock } from './CodeBlock'
import { ImageViewer, type ViewerImage } from './ImageViewer'
import { MarkdownTable } from './MarkdownTable'

/**
 * Markdown rendering split into React code blocks and tables with toolbars; other content remains
 * markdown-it HTML styled by sg-markdown rules.
 */
/**
 * base is the rendered file's directory when available, resolving relative links there instead of
 * at workspace root.
 */
export function Markdown({ text, base }: { text: string; base?: string }) {
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null)
  const conversationId = useContext(FileLinkContext)
  // Project cards, when the screen has context: turn their #12 references into links.
  const { projectId, cards: cardsByNumber } = useCardRefs()
  const cards = useMemo(() => (cardsByNumber.size > 0 ? new Set(cardsByNumber.keys()) : undefined), [cardsByNumber])
  const cardRefs = useCardRefPreview(projectId, cardsByNumber)

  // First pass collects cited paths without file links; its HTML displays while awaiting the server.
  const found = useMemo(
    () => parseMarkdown(text, { scope: conversationId ?? undefined, base, cards }),
    [text, conversationId, base, cards],
  )
  const known = useKnownFiles(found.candidates)

  // Second pass with known files, skipped when none match candidates, the common case.
  const linkable = useMemo(
    () => [...found.candidates].some((path) => known.has(path)),
    [found.candidates, known],
  )
  const segments = useMemo(
    () =>
      linkable
        ? parseMarkdown(text, { knownFiles: known, scope: conversationId ?? undefined, base, cards })
            .segments
        : found.segments,
    [linkable, text, known, conversationId, base, cards, found.segments],
  )

  /**
   * Open cited paths through one delegated container listener: injected HTML has no React component
   * for individual onClick handlers.
   */
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement
    const image = element instanceof HTMLImageElement ? element : element.closest('button, a')?.querySelector('img')
    if (image) {
      event.preventDefault()
      image.closest<HTMLElement>('button, a')?.focus()
      const all = [...event.currentTarget.closest('.sg-reading')!.querySelectorAll('img')]
      setViewer({ images: all.map((entry) => ({ src: entry.src, alt: entry.alt })), index: all.indexOf(image) })
      return
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-sg-path]')
    const path = target?.dataset.sgPath
    if (!path || !conversationId) return

    event.preventDefault()
    openTab(conversationId, path)
    setPanelTab('files')
    setPanelOpen(true)
  }

  return (
    // Listen on the whole container, not per segment: card references can occur inside separately
    // rendered table cells.
    <div className="sg-reading flex flex-col gap-3" {...cardRefs.handlers}>
      {viewer && <ImageViewer images={viewer.images} initialIndex={viewer.index} onClose={() => setViewer(null)} />}
      {cardRefs.preview}
      {segments.map((segment, index) => {
        // Use indices as keys: segments have no independent identity and rebuild fully whenever text changes.
        const key = `${segment.kind}-${index}`

        if (segment.kind === 'code') {
          return <CodeBlock key={key} language={segment.language} code={segment.code} />
        }
        if (segment.kind === 'table') {
          return <MarkdownTable key={key} html={segment.html} rows={segment.rows} />
        }
        return (
          <div
            key={key}
            className="sg-markdown"
            onClick={onClick}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        )
      })}
    </div>
  )
}
