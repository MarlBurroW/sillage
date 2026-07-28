import { isSpawnTool } from '@sillage/protocol'
import { hasVisibleContent, type ChatItem, type ToolItem } from './chat-fold'

/**
 * Mise en forme d'un fil avant rendu.
 *
 * Deux choses s'y jouent :
 *
 *   - un fil ne montre que ce que son auteur a produit. Ce qu'un sous-agent écrit et
 *     appelle porte l'identifiant de l'appel qui l'a lancé, et n'a rien à faire dans
 *     le fil principal : mêlé aux réponses de l'agent, il s'y lit comme si c'était
 *     lui qui parlait, et deux sous-agents en parallèle deviennent indémêlables. Le
 *     fil principal ne garde donc que l'appel de spawn ; le reste se lit dans le
 *     panneau, découpé par ce même module ;
 *   - une suite d'appels terminés se replie en une ligne, parce qu'elle n'apporte
 *     rien ligne par ligne et éloigne la réponse. Tant qu'un appel tourne, la suite
 *     reste dépliée : c'est justement le moment où on veut voir ce qui se passe.
 */

export type ChatRow =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'tool'; key: string; tool: ToolItem }
  | { kind: 'tool-group'; key: string; tools: ToolItem[] }

/** En dessous, replier coûte un clic et n'économise pas une ligne. */
const MIN_GROUP_SIZE = 2

/**
 * Découpe un fil en lignes affichables.
 *
 * `thread` désigne l'auteur du fil : `null` pour l'agent principal, l'identifiant de
 * l'appel de spawn pour un sous-agent. Tout ce qui n'est ni message ni appel d'outil
 * (permission, plan, question, erreur, repère) n'a pas d'auteur et reste dans le fil
 * principal : c'est le seul endroit d'où l'on peut répondre à une sollicitation, et le
 * seul où une erreur de session a un sens.
 */
export function buildRows(items: ChatItem[], thread: string | null = null): ChatRow[] {
  const rows: ChatRow[] = []
  let run: ToolItem[] = []

  const flush = () => {
    if (run.length === 0) return
    const first = run[0]
    if (first && run.length >= MIN_GROUP_SIZE && run.every((tool) => tool.status !== 'running')) {
      rows.push({ kind: 'tool-group', key: `tools-${first.id}`, tools: run })
    } else {
      for (const tool of run) rows.push({ kind: 'tool', key: tool.id, tool })
    }
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool') {
      if (item.parentToolCallId !== thread) continue

      // Le lancement d'un sous-agent garde sa ligne : c'est le seul repère qui dise
      // qu'un pan entier du travail s'est fait ailleurs, et noyé dans « 5 outils » il
      // ne se distingue plus d'un `Read`.
      if (isSpawnTool(item.name)) {
        flush()
        rows.push({ kind: 'tool', key: item.id, tool: item })
      } else {
        run.push(item)
      }
      continue
    }

    if (item.kind === 'message') {
      if (item.parentToolCallId !== thread) continue
    } else if (thread !== null) {
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
