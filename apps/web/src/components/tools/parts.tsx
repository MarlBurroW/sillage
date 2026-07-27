import type { ReactNode } from 'react'
import { HighlightedCode } from '../chat/HighlightedCode'
import { cx } from '../ui'

/**
 * Briques communes aux renderers d'outils.
 *
 * Elles existent pour que dix outils différents se lisent de la même façon : même
 * intitulé, même bloc de code, même hauteur maximale. Un renderer qui invente sa
 * propre mise en forme fait perdre plus qu'il n'apporte.
 */

/** Un bloc étiqueté. `hint` porte les précisions qui ne méritent pas leur propre bloc. */
export function Section({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string | null
  /** Absent quand l'intitulé et sa précision disent déjà tout : un chemin de fichier. */
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-[0.6875rem] font-medium tracking-wide text-ink-faint uppercase">
          {label}
        </span>
        {hint ? (
          <span className="min-w-0 truncate font-mono text-[0.6875rem] text-ink-faint" title={hint}>
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/** Cadre commun à tous les blocs de contenu, coloré ou non. */
const FRAME = 'max-h-80 overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-xs'

export function Code({
  content,
  language,
  wrap = false,
}: {
  content: string
  language: string
  wrap?: boolean
}) {
  return <HighlightedCode code={content} language={language} wrap={wrap} className={FRAME} />
}

/**
 * Du texte qu'on ne cherche pas à colorer : sortie de commande, résultat de recherche.
 * Deviner un langage sur une sortie de `ls` la rendrait moins lisible, pas plus.
 */
export function Plain({ content, tone }: { content: string; tone?: string }) {
  return <pre className={cx(FRAME, 'break-words whitespace-pre-wrap', tone)}>{content}</pre>
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-line bg-sunken p-2 font-mono text-xs text-ink-faint">
      {children}
    </p>
  )
}
