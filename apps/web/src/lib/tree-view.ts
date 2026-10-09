import { useSyncExternalStore } from 'react'
import type { WorkspaceScope } from './workspace-scope'

/**
 * Ce que l'explorateur doit retrouver d'un affichage à l'autre : les dossiers dépliés,
 * la sélection, et les entrées copiées ou coupées.
 *
 * Hors de React et par portée : la colonne se démonte quand on la referme, et la
 * recherche remplace l'arborescence le temps d'une saisie. Gardé dans les lignes, cet
 * état se perdait à chaque fois, et il fallait redéplier tout le chemin parcouru.
 *
 * Chaque ligne s'abonne à ce qui la concerne seule (est-elle dépliée, sélectionnée,
 * coupée) : cocher une entrée ne redessine pas les milliers d'autres.
 */
export interface TreeView {
  expanded: ReadonlySet<string>
  /** Chemin sélectionné → est-ce un dossier. Le type sert aux actions groupées. */
  selection: ReadonlyMap<string, boolean>
  /** Point de départ d'une sélection étendue à la Maj : le dernier clic simple. */
  anchor: string | null
  /**
   * Mode sélection, pour le doigt : sans touche Ctrl, c'est lui qui fait qu'un appui
   * coche une entrée au lieu de l'ouvrir.
   */
  selecting: boolean
  /** Entrées copiées ou coupées, avec leur type comme la sélection. */
  clipboard: { mode: 'copy' | 'cut'; entries: ReadonlyMap<string, boolean> } | null
}

const EMPTY: TreeView = {
  expanded: new Set(),
  selection: new Map(),
  anchor: null,
  selecting: false,
  clipboard: null,
}

const views = new Map<WorkspaceScope, TreeView>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTreeView(scope: WorkspaceScope): TreeView {
  return views.get(scope) ?? EMPTY
}

function update(scope: WorkspaceScope, change: (view: TreeView) => Partial<TreeView>): void {
  const current = getTreeView(scope)
  const next = { ...current, ...change(current) }
  // Une sélection vidée sort du mode sélection : sinon l'appui suivant cocherait encore
  // au lieu d'ouvrir, sans rien à l'écran pour dire pourquoi.
  if (next.selection.size === 0) next.selecting = false
  views.set(scope, next)
  for (const notify of listeners) notify()
}

/** Un sélecteur qui rend une valeur simple : la ligne ne se redessine que si elle change. */
export function useTreeView<T extends string | number | boolean | null>(
  scope: WorkspaceScope,
  select: (view: TreeView) => T,
): T {
  return useSyncExternalStore(
    subscribe,
    () => select(getTreeView(scope)),
    () => select(EMPTY),
  )
}

/** `path` est-il `ancestor` ou l'un de ses descendants. */
export function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

// Dossiers dépliés

export function setExpanded(scope: WorkspaceScope, path: string, open: boolean): void {
  update(scope, (view) => {
    const expanded = new Set(view.expanded)
    if (open) {
      expanded.add(path)
      return { expanded }
    }
    expanded.delete(path)
    // Ce qui se replie sort de la sélection : une entrée cochée puis cachée serait
    // emportée par la suppression suivante sans qu'on la voie.
    const selection = new Map(
      [...view.selection].filter(([selected]) => !selected.startsWith(`${path}/`)),
    )
    return { expanded, selection }
  })
}

/** Déplie tous les dossiers qui mènent à `path`, pour qu'il soit visible. */
export function revealPath(scope: WorkspaceScope, path: string): void {
  const parts = path.split('/')
  const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
  if (ancestors.every((ancestor) => getTreeView(scope).expanded.has(ancestor))) return
  update(scope, (view) => ({ expanded: new Set([...view.expanded, ...ancestors]) }))
}

export function collapseAll(scope: WorkspaceScope): void {
  update(scope, (view) => ({
    expanded: new Set(),
    // Seules restent cochées les entrées encore visibles, celles de la racine.
    selection: new Map([...view.selection].filter(([path]) => !path.includes('/'))),
  }))
}

// Sélection

export function selectOnly(scope: WorkspaceScope, path: string, isDirectory: boolean): void {
  update(scope, () => ({ selection: new Map([[path, isDirectory]]), anchor: path }))
}

export function toggleSelected(scope: WorkspaceScope, path: string, isDirectory: boolean): void {
  update(scope, (view) => {
    const selection = new Map(view.selection)
    if (selection.has(path)) selection.delete(path)
    else selection.set(path, isDirectory)
    return { selection, anchor: path }
  })
}

/**
 * Remplace la sélection par `entries`, ou l'y ajoute. L'ancre ne bouge que si elle est
 * donnée : un second Maj-clic repart du même point, comme dans tout explorateur.
 */
export function selectMany(
  scope: WorkspaceScope,
  entries: ReadonlyArray<readonly [string, boolean]>,
  { additive = false, anchor }: { additive?: boolean; anchor?: string } = {},
): void {
  update(scope, (view) => ({
    selection: new Map([...(additive ? view.selection : []), ...entries]),
    anchor: anchor ?? view.anchor,
  }))
}

export function clearSelection(scope: WorkspaceScope): void {
  update(scope, () => ({ selection: new Map(), anchor: null, selecting: false }))
}

/**
 * Entre en mode sélection avec cette entrée cochée. Hors du mode, la sélection repart
 * d'elle seule : la ligne désignée en touchant un dossier pour l'ouvrir n'a pas été
 * choisie pour en faire partie.
 */
export function startSelecting(scope: WorkspaceScope, path: string, isDirectory: boolean): void {
  update(scope, (view) => ({
    selection: new Map([...(view.selecting ? view.selection : []), [path, isDirectory]]),
    anchor: path,
    selecting: true,
  }))
}

// Presse-papiers

export function setTreeClipboard(
  scope: WorkspaceScope,
  mode: 'copy' | 'cut',
  entries: ReadonlyArray<readonly [string, boolean]>,
): void {
  update(scope, () => ({ clipboard: entries.length > 0 ? { mode, entries: new Map(entries) } : null }))
}

export function clearTreeClipboard(scope: WorkspaceScope): void {
  update(scope, () => ({ clipboard: null }))
}

// Suivi des manipulations

/**
 * Reporte un renommage ou un déplacement : un dossier déplié le reste sous son nouveau
 * nom, une entrée sélectionnée aussi.
 */
export function renameInView(scope: WorkspaceScope, from: string, to: string): void {
  const move = (path: string) => (isWithin(path, from) ? to + path.slice(from.length) : path)
  update(scope, (view) => ({
    expanded: new Set([...view.expanded].map(move)),
    selection: new Map([...view.selection].map(([path, isDirectory]) => [move(path), isDirectory])),
    anchor: view.anchor === null ? null : move(view.anchor),
    clipboard: view.clipboard && {
      ...view.clipboard,
      entries: new Map([...view.clipboard.entries].map(([path, isDirectory]) => [move(path), isDirectory])),
    },
  }))
}

/** Oublie des entrées supprimées, et tout ce qu'elles contenaient. */
export function forgetInView(scope: WorkspaceScope, removed: string[]): void {
  const gone = (path: string) => removed.some((entry) => isWithin(path, entry))
  update(scope, (view) => ({
    expanded: new Set([...view.expanded].filter((path) => !gone(path))),
    selection: new Map([...view.selection].filter(([path]) => !gone(path))),
    anchor: view.anchor !== null && gone(view.anchor) ? null : view.anchor,
    clipboard: view.clipboard && {
      ...view.clipboard,
      entries: new Map([...view.clipboard.entries].filter(([path]) => !gone(path))),
    },
  }))
}

/**
 * Retire les entrées déjà comprises dans un dossier de la liste : déplacer un dossier
 * et l'un de ses fichiers déplacerait sinon le fichier deux fois, la seconde en vain.
 */
export function topLevelPaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)]
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)),
  )
}
