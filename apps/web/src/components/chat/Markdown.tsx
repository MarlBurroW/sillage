import { useContext, useMemo, type MouseEvent } from 'react'
import { openTab } from '../../lib/editor-tabs'
import { FileLinkContext, useKnownFiles } from '../../lib/file-links'
import { parseMarkdown } from '../../lib/markdown'
import { setPanelOpen, setPanelTab } from '../../lib/panel'
import { CodeBlock } from './CodeBlock'
import { MarkdownTable } from './MarkdownTable'

/**
 * Rendu d'un texte markdown.
 *
 * Le document est découpé : les blocs de code et les tableaux deviennent des
 * composants React, qui portent leur barre d'outils, et tout le reste est le HTML de
 * markdown-it, stylé par les règles `.sg-markdown`.
 */
export function Markdown({ text }: { text: string }) {
  const conversationId = useContext(FileLinkContext)

  // Première passe : ce que le texte cite. Elle ne produit aucun lien, mais son HTML
  // est celui affiché tant que la réponse du serveur n'est pas là.
  const found = useMemo(() => parseMarkdown(text, { scope: conversationId ?? undefined }), [
    text,
    conversationId,
  ])
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
        ? parseMarkdown(text, { knownFiles: known, scope: conversationId ?? undefined }).segments
        : found.segments,
    [linkable, text, known, conversationId, found.segments],
  )

  /**
   * Ouverture d'un chemin cité.
   *
   * Écouteur unique sur le conteneur plutôt qu'un par lien : le HTML est injecté tel
   * quel, il n'y a pas de composant React où accrocher un `onClick`.
   */
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-sg-path]')
    const path = target?.dataset.sgPath
    if (!path || !conversationId) return

    event.preventDefault()
    openTab(conversationId, path)
    setPanelTab('files')
    setPanelOpen(true)
  }

  return (
    <div className="sg-reading flex flex-col gap-3">
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
