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
 *     rien ligne par ligne et éloigne la réponse. Un appel en cours garde la sienne :
 *     c'est le seul qu'on ait une raison de regarder pendant qu'il tourne.
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

  /**
   * Vide la suite courante.
   *
   * Les appels terminés se regroupent, les appels en cours gardent leur ligne, et
   * l'ordre chronologique est conservé : plusieurs appels peuvent tourner en parallèle,
   * et rien ne garantit que celui qui tourne soit le dernier de la suite.
   *
   * Le groupe ne se dissout pas quand un appel démarre derrière lui. Il le faisait
   * auparavant, et c'était visible deux fois : la suite entière se dépliait le temps du
   * nouvel appel puis se repliait d'un coup, et un groupe ouvert à la main se refermait
   * en même temps, puisque la ligne disparaissait et que le composant perdait son état.
   */
  const flush = () => {
    if (run.length === 0) return

    let done: ToolItem[] = []
    const flushDone = () => {
      const first = done[0]
      if (first && done.length >= MIN_GROUP_SIZE) {
        rows.push({ kind: 'tool-group', key: `tools-${first.id}`, tools: done })
      } else {
        for (const tool of done) rows.push({ kind: 'tool', key: tool.id, tool })
      }
      done = []
    }

    for (const tool of run) {
      if (tool.status === 'running') {
        flushDone()
        rows.push({ kind: 'tool', key: tool.id, tool })
      } else {
        done.push(tool)
      }
    }
    flushDone()

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
