import { useEffect, useState } from 'react'
import { highlight, isHighlighterReady, loadHighlighter } from '../../lib/highlight'
import { cx } from '../ui'

/**
 * Code coloré, dans un `<pre>`.
 *
 * La bibliothèque de coloration est chargée à la demande : le premier bloc affiché de
 * la session apparaît d'abord en clair, puis se colore, plutôt que d'être retenu le
 * temps du téléchargement.
 */
export function HighlightedCode({
  code,
  language,
  wrap = false,
  className,
}: {
  code: string
  /** Vide, inconnu ou trop volumineux : le code reste en clair. */
  language: string
  wrap?: boolean
  className?: string
}) {
  const [rendered, setRendered] = useState(() => highlight(code, language))

  useEffect(() => {
    setRendered(highlight(code, language))
    if (isHighlighterReady()) return

    let cancelled = false
    void loadHighlighter().then(() => {
      if (!cancelled) setRendered(highlight(code, language))
    })
    return () => {
      cancelled = true
    }
  }, [code, language])

  return (
    <pre className={cx('overflow-x-auto', wrap && 'break-words whitespace-pre-wrap', className)}>
      {rendered.applied ? (
        // Les jetons sont des `<span>` de classes `hljs-*`, stylés avec les tokens de
        // thème (voir index.css).
        <code className="hljs" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      ) : (
        // Rendu comme texte : React échappe, on n'a rien à assainir nous-mêmes.
        <code>{code}</code>
      )}
    </pre>
  )
}
