import type { SillageEvent } from '@sillage/protocol'
import type { RunnerContext } from './types.js'

type ErrorEvent = Extract<SillageEvent, { type: 'error' }>

/**
 * Raconte au journal la mort d'un runner : la panne s'il y en a une, puis la fin de
 * session qui referme le tour.
 *
 * La fin de session est ce qui éteint l'indicateur d'activité côté web. Un `error`
 * seul laisse le tour ouvert dans le fil replié, donc la conversation affichée « en
 * cours » à chaque rechargement, indéfiniment : c'est arrivé sur une écriture de
 * journal refusée en pleine session.
 *
 * Le statut est posé par l'appelant, avant l'appel : ce qui vient de tuer le runner
 * peut être l'écriture du journal elle-même, et le statut est le seul des deux qui
 * déverrouille l'interface. L'échec d'écriture s'arrête donc sur la sortie d'erreur,
 * plutôt que de remonter dans un `void consume()` ou un gestionnaire de sortie de
 * process, où il abattrait le daemon pour une base momentanément occupée.
 */
export function journalDeath(ctx: Pick<RunnerContext, 'emit'>, error: ErrorEvent | null): void {
  try {
    if (error) ctx.emit(error)
    ctx.emit({ type: 'session.ended', reason: 'interrupted' })
  } catch (err) {
    console.error('sillage: fin de session non journalisée', err)
  }
}
