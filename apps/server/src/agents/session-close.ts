import type { SillageEvent } from '@sillage/protocol'
import type { RunnerContext } from './types.js'

type ErrorEvent = Extract<SillageEvent, { type: 'error' }>

/** Journals runner death: failure when present, then session ending to close turns. `error` alone leaves folded turns open and activity permanently running after reload, observed after rejected journal writes. Callers set status first because journal writing itself may have killed runners, and only status unlocks interfaces. Log write failures to stderr rather than propagate through unawaited consume loops or exit handlers and crash daemons over temporarily busy databases. */
export function journalDeath(ctx: Pick<RunnerContext, 'emit'>, error: ErrorEvent | null): void {
  try {
    if (error) ctx.emit(error)
    ctx.emit({ type: 'session.ended', reason: 'interrupted' })
  } catch (err) {
    console.error('sillage: fin de session non journalisée', err)
  }
}
