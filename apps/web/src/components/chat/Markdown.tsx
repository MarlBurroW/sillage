import { useMemo } from 'react'
import { parseMarkdown } from '../../lib/markdown'
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
  const segments = useMemo(() => parseMarkdown(text), [text])

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
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        )
      })}
    </div>
  )
}
