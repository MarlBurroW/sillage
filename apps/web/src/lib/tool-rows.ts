import { hasVisibleContent, type ChatItem, type MessageItem, type ToolItem } from './chat-fold'

/**
 * Mise en forme des appels d'outils avant rendu.
 *
 * Trois choses s'y jouent :
 *
 *   - un outil qui lance un sous-agent (`Agent`) provoque d'autres appels, que le CLI
 *     rattache par `parentToolCallId`. Ils sont imbriqués sous leur parent plutôt que
 *     simplement décalés : une indentation flottante ne dit pas de quel sous-agent
 *     viennent les appels, et deux sous-agents en parallèle seraient indémêlables ;
 *   - ce que le sous-agent écrit est rattaché de la même façon. Laissé dans le fil, il
 *     s'y intercale comme une réponse de l'agent principal, sans rien qui dise qui
 *     parle, et le fil se retrouve coupé en deux par le rapport d'un sous-agent ;
 *   - une suite d'appels terminés se replie en une ligne, parce qu'elle n'apporte
 *     rien ligne par ligne et éloigne la réponse. Tant qu'un appel tourne, la suite
 *     reste dépliée : c'est justement le moment où on veut voir ce qui se passe.
 */

/** Un appel, et ce que le sous-agent qu'il a lancé a produit. */
export interface ToolNode {
  tool: ToolItem
  children: ToolNode[]
  messages: MessageItem[]
}

export type ChatRow =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'tool'; key: string; node: ToolNode }
  | { kind: 'tool-group'; key: string; nodes: ToolNode[] }

/** En dessous, replier coûte un clic et n'économise pas une ligne. */
const MIN_GROUP_SIZE = 2

/** Un appel n'est terminé que lorsque tout ce qu'il a déclenché l'est aussi. */
/** Vrai si le sous-agent de cet appel, ou d'un appel imbriqué, a écrit un rapport. */
function hasReport(node: ToolNode): boolean {
  return node.messages.length > 0 || node.children.some(hasReport)
}

export function isSettled(node: ToolNode): boolean {
  return node.tool.status !== 'running' && node.children.every(isSettled)
}

/**
 * Rattache chaque appel et chaque message à son parent. Un parent inconnu (journal
 * tronqué, sous-agent dont l'appel initial est hors de la page chargée) laisse
 * l'élément à la racine plutôt que de le faire disparaître.
 */
function buildTree(items: ChatItem[]): { nodes: Map<string, ToolNode>; roots: Set<string> } {
  const nodes = new Map<string, ToolNode>()
  for (const item of items) {
    if (item.kind === 'tool') nodes.set(item.id, { tool: item, children: [], messages: [] })
  }

  const roots = new Set<string>()
  for (const item of items) {
    if (item.kind === 'message') {
      const parent = item.parentToolCallId ? nodes.get(item.parentToolCallId) : undefined
      if (parent && hasVisibleContent(item)) parent.messages.push(item)
      continue
    }
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
      if (!node) continue

      // Un appel dont le sous-agent a écrit un rapport garde sa carte dépliée dans
      // le fil : replié dans un groupe « N outils », le rapport disparaîtrait de
      // l'écran (et de la recherche en page) alors que c'est souvent la substance
      // du tour.
      if (hasReport(node)) {
        flush()
        rows.push({ kind: 'tool', key: node.tool.id, node })
      } else {
        run.push(node)
      }
      continue
    }

    // Déjà rendu dans la carte du sous-agent qui l'a écrit.
    if (item.kind === 'message' && item.parentToolCallId && nodes.has(item.parentToolCallId)) continue

    // Un élément qui n'affiche rien ne doit pas interrompre la suite d'outils.
    if (!hasVisibleContent(item)) continue

    flush()
    rows.push({ kind: 'item', key: item.id, item })
  }
  flush()

  return rows
}
