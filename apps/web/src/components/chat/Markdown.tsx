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
 * Rendu d'un texte markdown.
 *
 * Le document est découpé : les blocs de code et les tableaux deviennent des
 * composants React, qui portent leur barre d'outils, et tout le reste est le HTML de
 * markdown-it, stylé par les règles `.sg-markdown`.
 */
/**
 * `base` : dossier du fichier rendu, quand le texte en est un. Ses liens relatifs en
 * partent, au lieu de partir de la racine du workspace.
 */
export function Markdown({ text, base }: { text: string; base?: string }) {
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null)
  const conversationId = useContext(FileLinkContext)
  // Les cartes du projet, quand l'écran en a un : leurs `#12` deviennent des liens.
  const { projectId, cards: cardsByNumber } = useCardRefs()
  const cards = useMemo(() => (cardsByNumber.size > 0 ? new Set(cardsByNumber.keys()) : undefined), [cardsByNumber])
  const cardRefs = useCardRefPreview(projectId, cardsByNumber)

  // Première passe : ce que le texte cite. Elle ne produit aucun lien de fichier, mais
  // son HTML est celui affiché tant que la réponse du serveur n'est pas là.
  const found = useMemo(
    () => parseMarkdown(text, { scope: conversationId ?? undefined, base, cards }),
    [text, conversationId, base, cards],
  )
  const known = useKnownFiles(found.candidates)

  // Seconde passe, une fois les fichiers connus. Sautée quand aucun candidat du texte
  // n'en fait partie, ce qui est le cas le plus fréquent.
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
   * Ouverture d'un chemin cité.
   *
   * Écouteur unique sur le conteneur plutôt qu'un par lien : le HTML est injecté tel
   * quel, il n'y a pas de composant React où accrocher un `onClick`.
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
    // Sur le conteneur entier et non segment par segment : un `#12` peut aussi bien
    // tomber dans une cellule de tableau, rendue par son propre composant.
    <div className="sg-reading flex flex-col gap-3" {...cardRefs.handlers}>
      {viewer && <ImageViewer images={viewer.images} initialIndex={viewer.index} onClose={() => setViewer(null)} />}
      {cardRefs.preview}
      {segments.map((segment, index) => {
        // L'index comme clé : les segments n'ont pas d'identité propre et la liste est
        // reconstruite entièrement à chaque changement du texte.
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
