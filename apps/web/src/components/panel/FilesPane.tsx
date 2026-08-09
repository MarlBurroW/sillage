import { useEffect, useRef } from 'react'
import { useTranslate } from '../../lib/i18n'
import { restoreTreeWidth, setPanelTree, setTreeWidth, usePanelTree } from '../../lib/panel'
import { resizeHandle } from '../../lib/resize-handle'
import { useTreeSync } from '../../lib/tree'
import { cx } from '../ui'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'

/**
 * Arborescence et éditeur dans la même vue.
 *
 * Deux onglets exclusifs auparavant, ce qui obligeait à quitter l'arbre pour voir le
 * fichier ouvert : de là venaient le double clic, garde-fou contre une navigation qui
 * coûtait cher, et l'impression d'empiler des onglets dans des onglets.
 *
 * Sous `NARROW_PX` de large, les deux ne tiennent plus côte à côte : la colonne passe
 * par-dessus l'éditeur et se referme dès qu'un fichier est choisi. C'est le cas au
 * doigt, où le panneau occupe l'écran entier.
 */
/** À tenir en accord avec les seuils `@min-[35rem]` et `@max-[35rem]` ci-dessous. */
const NARROW_PX = 560

export function FilesPane({ conversationId }: { conversationId: string }) {
  const t = useTranslate()
  const treeOpen = usePanelTree()
  const host = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  useTreeSync(conversationId)
  useEffect(restoreTreeWidth, [])

  /**
   * Mesuré au moment du clic plutôt que suivi en état : la largeur ne sert qu'à
   * décider si l'ouverture doit refermer la colonne, et l'observer en continu
   * re-rendrait l'arborescence à chaque glissement de la poignée.
   */
  const closeIfOverlaid = () => {
    const width = host.current?.getBoundingClientRect().width ?? 0
    if (width < NARROW_PX) setPanelTree(false, false)
  }

  /**
   * La colonne commence au bord gauche du cadre : l'abscisse du pointeur moins ce bord
   * est la largeur voulue, sans décalage à mémoriser au début du geste.
   *
   * Le cadre est remesuré à chaque événement plutôt qu'au début du glissement : le
   * panneau qui le porte a sa propre poignée, et une fenêtre redimensionnée en cours de
   * geste laisserait sinon la colonne se caler sur une place qui n'existe plus.
   */
  const handle = resizeHandle({
    widthAt: (clientX) => clientX - (host.current?.getBoundingClientRect().left ?? 0),
    current: () => column.current?.getBoundingClientRect().width ?? null,
    apply: (width, persist) =>
      setTreeWidth(width, host.current?.getBoundingClientRect().width ?? 0, persist),
  })

  // `relative` : c'est ce cadre qui ancre la colonne quand elle se pose au-dessus.
  return (
    <div ref={host} className="@container relative flex min-h-0 min-w-0 flex-1">
      {treeOpen ? (
        <div
          ref={column}
          className={cx(
            'min-h-0 shrink-0 overflow-auto border-r border-line py-1',
            // Colonne à côté de l'éditeur quand la place existe, sinon calque au-dessus.
            // `bg-surface` seulement dans ce second cas : une colonne opaque posée sur
            // le panneau y dessinerait un rectangle plus clair sans raison.
            // La largeur est bornée en CSS et pas seulement au glissement : un panneau
            // rétréci après coup laisserait sinon une colonne trop large pour lui.
            '@min-[35rem]:w-[min(var(--tree-width,15rem),60%)]',
            '@max-[35rem]:absolute @max-[35rem]:inset-y-0 @max-[35rem]:left-0 @max-[35rem]:z-10',
            '@max-[35rem]:w-full @max-[35rem]:bg-surface @max-[35rem]:shadow-card',
          )}
        >
          <FileTree conversationId={conversationId} onOpenFile={closeIfOverlaid} />
        </div>
      ) : null}

      {/* Poignée seulement quand la colonne est posée à côté de l'éditeur : par-dessus,
          elle n'a aucune place à partager, et au doigt elle tomberait au milieu de
          l'écran sur un geste de défilement. */}
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

      {/* `min-w-0` : sans lui, un enfant flex se dimensionne sur son contenu, et
          l'éditeur imposait sa largeur au panneau au lieu de défiler dedans. */}
      <div className="min-h-0 min-w-0 flex-1">
        <EditorPane conversationId={conversationId} />
      </div>
    </div>
  )
}
