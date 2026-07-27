import type { DiffHunk } from '../lib/diff'
import { highlight, languageFromPath, useHighlighterReady } from '../lib/highlight'
import { cx } from './ui'

/**
 * Les sections d'un diff unifié.
 *
 * Partagé par le panneau de modifications et par les renderers d'outils : l'état
 * courant vient de git, l'historique du journal, un appel d'outil de son propre
 * payload, mais les trois montrent la même chose et doivent se lire pareil.
 */
export function DiffHunks({ hunks, path }: { hunks: DiffHunk[]; path: string }) {
  const ready = useHighlighterReady()
  const language = languageFromPath(path)

  return (
    <>
      {hunks.map((hunk) => (
        <div key={hunk.header} className="overflow-x-auto">
          <p className="bg-surface-high px-2.5 py-1 font-mono text-[0.625rem] text-ink-faint">
            {hunk.header}
          </p>
          <table className="w-full border-collapse font-mono text-[0.6875rem]">
            <tbody>
              {hunk.lines.map((line, index) => (
                <tr
                  key={index}
                  className={cx(
                    line.kind === 'added' && 'bg-positive/12',
                    line.kind === 'removed' && 'bg-critical/12',
                  )}
                >
                  {/* Les numéros ne se sélectionnent pas : copier un extrait de diff
                      doit donner du code, pas du code numéroté. */}
                  <td className="w-8 border-r border-line/60 px-1 text-right text-ink-faint/70 select-none">
                    {line.before ?? ''}
                  </td>
                  <td className="w-8 border-r border-line/60 px-1 text-right text-ink-faint/70 select-none">
                    {line.after ?? ''}
                  </td>
                  <td className="px-1.5 whitespace-pre text-ink-soft">
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                    <DiffCode text={line.text} language={ready ? language : ''} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}

/**
 * Une ligne de diff colorée.
 *
 * Colorée ligne à ligne, et non par bloc : un diff n'est pas du code continu, ses
 * lignes supprimées et ajoutées ne coexistent nulle part. Un commentaire multiligne ou
 * un littéral de gabarit peut donc être mal coloré, ce que `ignoreIllegals` rend
 * inoffensif, et que la lecture d'un diff pardonne largement.
 */
function DiffCode({ text, language }: { text: string; language: string }) {
  const rendered = highlight(text, language)

  return rendered.applied ? (
    // Les jetons sont des `<span>` de classes `hljs-*`, stylés avec les tokens de thème.
    <span className="hljs" dangerouslySetInnerHTML={{ __html: rendered.html }} />
  ) : (
    // Rendu comme texte : React échappe, on n'a rien à assainir nous-mêmes.
    <>{text}</>
  )
}
