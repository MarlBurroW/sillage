import { isSpawnTool } from '@sillage/protocol'
import type { ChatState } from './chat-fold'

/**
 * Les travaux sans autre représentation à l'écran, dérivés du seul journal
 * (invariant I2).
 *
 * Le CLI annonce dans une même liste tout ce qui vit : les sous-agents que le fil
 * affiche déjà comme les workflows dont il ne sait rien. Un sous-agent a son bandeau,
 * sa ligne et son fil, qu'il soit passé en arrière-plan ou non ; le répéter ici
 * dirait deux fois la même chose, et noierait le seul cas que cette vue existe pour
 * montrer. Ne restent donc que les travaux qui n'ont nulle part où s'afficher :
 * workflows, commandes lancées en fond, surveillances.
 */

export interface BackgroundWork {
  id: string
  kind: string
  description: string
  /** Ce qu'il fait à l'instant, nul tant qu'il n'a pas rendu compte. */
  activity: string | null
  lastTool: string | null
  toolUses: number
  totalTokens: number
}

export function buildBackground(state: ChatState): BackgroundWork[] {
  const works: BackgroundWork[] = []
  const spawned = new Set(
    state.items
      .filter((item) => item.kind === 'tool' && isSpawnTool(item.name))
      .map((item) => item.id),
  )

  for (const live of state.background) {
    const task = state.tasks.get(live.id)
    // Un travail dont le lancement manque au fil replié n'est rattachable à rien : le
    // montrer vaut mieux que le taire, puisque la liste de niveau, elle, affirme qu'il
    // tourne. C'est le cas d'un fil rechargé après un retard trop grand pour le socket.
    if (task?.toolCallId && spawned.has(task.toolCallId)) continue

    works.push({
      id: live.id,
      kind: live.kind,
      description: task?.description || live.description,
      activity: task?.activity ?? null,
      lastTool: task?.lastTool ?? null,
      toolUses: task?.toolUses ?? 0,
      totalTokens: task?.totalTokens ?? 0,
    })
  }

  return works
}
