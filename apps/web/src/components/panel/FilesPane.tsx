import { useRef } from 'react'
import { setPanelTree, usePanelTree } from '../../lib/panel'
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
  const treeOpen = usePanelTree()
  const host = useRef<HTMLDivElement>(null)

  /**
   * Mesuré au moment du clic plutôt que suivi en état : la largeur ne sert qu'à
   * décider si l'ouverture doit refermer la colonne, et l'observer en continu
   * re-rendrait l'arborescence à chaque glissement de la poignée.
   */
  const closeIfOverlaid = () => {
    const width = host.current?.getBoundingClientRect().width ?? 0
    if (width < NARROW_PX) setPanelTree(false, false)
  }

  // `relative` : c'est ce cadre qui ancre la colonne quand elle se pose au-dessus.
  return (
    <div ref={host} className="@container relative flex min-h-0 min-w-0 flex-1">
      {treeOpen ? (
        <div
          className={cx(
            'min-h-0 shrink-0 overflow-auto border-r border-line py-1',
            // Colonne à côté de l'éditeur quand la place existe, sinon calque au-dessus.
            // `bg-surface` seulement dans ce second cas : une colonne opaque posée sur
            // le panneau y dessinerait un rectangle plus clair sans raison.
            '@min-[35rem]:w-60',
            '@max-[35rem]:absolute @max-[35rem]:inset-y-0 @max-[35rem]:left-0 @max-[35rem]:z-10',
            '@max-[35rem]:w-full @max-[35rem]:bg-surface @max-[35rem]:shadow-card',
          )}
        >
          <FileTree conversationId={conversationId} onOpenFile={closeIfOverlaid} />
        </div>
      ) : null}

      {/* `min-w-0` : sans lui, un enfant flex se dimensionne sur son contenu, et
          l'éditeur imposait sa largeur au panneau au lieu de défiler dedans. */}
      <div className="min-h-0 min-w-0 flex-1">
        <EditorPane conversationId={conversationId} />
      </div>
    </div>
  )
}
