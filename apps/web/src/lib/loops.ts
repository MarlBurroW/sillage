import { loopKey, type ChatState } from './chat-fold'

/**
 * Les boucles armées, enrichies de ce que le CLI ne compte pas (invariant I2).
 *
 * `SessionCronSummary` donne la cadence et la consigne, rien d'autre : ni la date du
 * prochain tir, ni le nombre de fois qu'il a eu lieu. Le premier n'est de toute façon
 * pas affichable, le CLI décalant chaque tir d'une gigue qui va jusqu'à la moitié de
 * l'intervalle ; le second se déduit du journal, chaque réveil y laissant la consigne
 * que le CLI a réinjectée.
 */

export interface ArmedLoop {
  id: string
  /** Expression cron à cinq champs, telle que le CLI la tient. */
  schedule: string
  recurring: boolean
  prompt: string
  /** Réveils observés dans ce journal. 0 tant que la boucle n'a pas encore tiré. */
  iterations: number
  /** Date du dernier réveil, nulle tant qu'il n'y en a pas eu. */
  lastFiredAt: number | null
}

export function buildLoops(state: ChatState): ArmedLoop[] {
  return state.loops.map((loop) => {
    const fires = state.loopFires.get(loopKey(loop.prompt))
    return {
      id: loop.id,
      schedule: loop.schedule,
      recurring: loop.recurring,
      prompt: loop.prompt,
      iterations: fires?.count ?? 0,
      lastFiredAt: fires?.lastAt ?? null,
    }
  })
}

/**
 * L'ancienneté d'un réveil, à la maille où elle apprend quelque chose.
 *
 * Les unités s'écrivent pareil en français et en anglais, seule la phrase qui les
 * entoure est traduite.
 */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '< 1 min'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h`
}

/**
 * La cadence en clair, pour les expressions que `/loop` produit.
 *
 * Volontairement partiel : `/loop` n'écrit que des pas et des valeurs fixes sur le
 * champ des minutes ou des heures, et le reste vient d'une demande formulée à la main,
 * que l'expression brute décrit mieux qu'une paraphrase approximative.
 */
export function describeSchedule(schedule: string): string | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.trim().split(/\s+/)
  if (minute === undefined || hour === undefined) return null
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null

  const everyMinutes = /^\*\/(\d+)$/.exec(minute)
  if (everyMinutes && hour === '*') return `${everyMinutes[1]}m`

  const everyHours = /^\*\/(\d+)$/.exec(hour)
  if (everyHours && /^\d+$/.test(minute)) return `${everyHours[1]}h`

  if (/^\d+$/.test(minute) && hour === '*') return '1h'

  return null
}
