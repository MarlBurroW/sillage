/**
 * Libellé de fenêtre de quota, à partir de ce que le CLI annonce.
 *
 * `compact` pour la pastille du fil (« 2 j »), long pour le panneau de consommation
 * (« 2 jours »). Une seule implémentation : les deux variantes divergeaient déjà en
 * silence quand elles étaient recopiées.
 */
export function describeWindow(
  limitName: string | null,
  durationMins: number | null,
  compact = false,
): string {
  if (limitName) return limitName
  if (durationMins === null) return 'quota'
  if (durationMins < 60) return `${durationMins} min`
  const hours = durationMins / 60
  // 168 h se lit mal : au-delà d'une journée, on exprime en jours.
  if (hours >= 24 && hours % 24 === 0) {
    return compact ? `${hours / 24} j` : `${hours / 24} jours`
  }
  return compact ? `${Math.round(hours)} h` : `${Math.round(hours)} heures`
}
