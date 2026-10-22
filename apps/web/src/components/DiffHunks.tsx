import type { DiffHunk } from '../lib/diff'
import { highlight, languageFromPath, useHighlighterReady } from '../lib/highlight'
import { cx } from './ui'

/**
 * Unified diff hunks shared by changes panels and tool renderers. Current state comes from Git,
 * history from logs, calls from payloads, but all show the same structure and need consistent
 * reading.
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
                  {/* Exclude line numbers from selection so copied diffs produce code rather than numbered code. */}
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
 * Highlight diff lines individually rather than as continuous code because removed and added lines
 * never coexist. Multiline comments/templates may highlight imperfectly; ignoreIllegals makes this
 * harmless and acceptable for diffs.
 */
function DiffCode({ text, language }: { text: string; language: string }) {
  const rendered = highlight(text, language)

  return rendered.applied ? (
    // Tokens are hljs spans styled through theme tokens.
    <span className="hljs" dangerouslySetInnerHTML={{ __html: rendered.html }} />
  ) : (
    // Render as text and let React escape without manual sanitization.
    <>{text}</>
  )
}
