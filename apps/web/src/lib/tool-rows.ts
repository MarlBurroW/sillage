import { hasVisibleContent, type ChatItem, type ToolItem } from './chat-fold'

/**
 * Mise en forme des appels d'outils avant rendu.
 *
 * Deux choses s'y jouent :
 *
 *   - un outil qui lance un sous-agent (`Agent`) provoque d'autres appels, que le CLI
 *     rattache par `parentToolCallId`. Ils sont imbriqués sous leur parent plutôt que
 *     simplement décalés : une indentation flottante ne dit pas de quel sous-agent
 *     viennent les appels, et deux sous-agents en parallèle seraient indémêlables ;
 *   - une suite d'appels terminés se replie en une ligne, parce qu'elle n'apporte
 *     rien ligne par ligne et éloigne la réponse. Tant qu'un appel tourne, la suite
 *     reste dépliée : c'est justement le moment où on veut voir ce qui se passe.
 */

/** Un appel et ceux que le sous-agent qu'il a lancé a produits. */
export interface ToolNode {
  tool: ToolItem
  children: ToolNode[]
}

export type ChatRow =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'tool'; key: string; node: ToolNode }
  | { kind: 'tool-group'; key: string; nodes: ToolNode[] }

/** En dessous, replier coûte un clic et n'économise pas une ligne. */
const MIN_GROUP_SIZE = 2

/** Un appel n'est terminé que lorsque tout ce qu'il a déclenché l'est aussi. */
export function isSettled(node: ToolNode): boolean {
  return node.tool.status !== 'running' && node.children.every(isSettled)
}

/**
 * Rattache chaque appel à son parent. Un parent inconnu (journal tronqué, sous-agent
 * dont l'appel initial est hors de la page chargée) laisse l'appel à la racine plutôt
 * que de le faire disparaître.
 */
function buildTree(items: ChatItem[]): { nodes: Map<string, ToolNode>; roots: Set<string> } {
  const nodes = new Map<string, ToolNode>()
  for (const item of items) {
    if (item.kind === 'tool') nodes.set(item.id, { tool: item, children: [] })
  }

  const roots = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const node = nodes.get(item.id)
    if (!node) continue

    const parent = item.parentToolCallId ? nodes.get(item.parentToolCallId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.add(item.id)
  }

  return { nodes, roots }
}

export function buildRows(items: ChatItem[]): ChatRow[] {
  const { nodes, roots } = buildTree(items)

  const rows: ChatRow[] = []
  let run: ToolNode[] = []

  const flush = () => {
    if (run.length === 0) return
    const first = run[0]
    if (first && run.length >= MIN_GROUP_SIZE && run.every(isSettled)) {
      rows.push({ kind: 'tool-group', key: `tools-${first.tool.id}`, nodes: run })
    } else {
      for (const node of run) rows.push({ kind: 'tool', key: node.tool.id, node })
    }
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool') {
      // Les appels d'un sous-agent sont déjà rendus sous leur parent.
      if (!roots.has(item.id)) continue
      const node = nodes.get(item.id)
      if (node) run.push(node)
      continue
    }

    // Un élément qui n'affiche rien ne doit pas interrompre la suite d'outils.
    if (!hasVisibleContent(item)) continue

    flush()
    rows.push({ kind: 'item', key: item.id, item })
  }
  flush()

  return rows
}
