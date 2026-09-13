/**
 * Durée des appels d'outils, mesurée entre leur annonce et leur résultat.
 *
 * Mesure de repli quand le CLI ne transmet pas sa durée ; elle vaut zéro
 * quand l'ouverture n'a pas été vue (reprise de session, résultat orphelin).
 */
export class ToolDurations {
  private readonly startedAt = new Map<string, number>()

  start(id: string): void {
    this.startedAt.set(id, Date.now())
  }

  stop(id: string): number {
    const started = this.startedAt.get(id)
    this.startedAt.delete(id)
    return started ? Date.now() - started : 0
  }
}
