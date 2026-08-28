import type { AgentKind } from './events.js'

/**
 * Ce que chaque CLI sait faire, au-delà du contrat commun.
 *
 * Source unique, partagée par le serveur et le frontend : l'UI ne propose pas un
 * geste que le CLI refuserait (le bouton n'existe pas plutôt que d'être offert puis
 * refusé), et le serveur garde le refus à l'exécution comme filet. Vérifier une
 * capacité ici plutôt que `agent === 'codex'` : un prochain CLI hérite du bon
 * comportement en remplissant sa ligne, sans chasse aux comparaisons de noms.
 */
export interface AgentCapabilities {
  /** Infléchir le tour en cours sans l'interrompre ni en ouvrir un autre. */
  steer: boolean
  /** Le CLI soumet ses plans à validation avant d'exécuter (`plan.review_requested`). */
  planReview: boolean
  /**
   * Le CLI persiste ses sessions locales dans un format que Sillage sait relire :
   * import de sessions commencées au CLI, et resynchronisation du journal après un
   * passage par lui.
   */
  cliSessions: boolean
  /**
   * Le CLI sait arrêter un travail de fond (`background.updated`) sur demande, par
   * l'identifiant que la liste porte. La clôture revient par le flux ordinaire, en
   * `background.updated` sans la tâche arrêtée.
   */
  stopBackgroundTask: boolean
  /**
   * Le CLI sait lister ses commandes en `/` pour un dossier sans qu'une session
   * tourne : le brouillon d'une conversation les propose avant le premier tour.
   * Codex n'a pas de commandes en `/` ; ses compétences en `$` arrivent au premier tour.
   */
  draftCommands: boolean
}

export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  claude: {
    steer: true,
    planReview: true,
    cliSessions: true,
    stopBackgroundTask: true,
    draftCommands: true,
  },
  codex: {
    steer: true,
    planReview: false,
    cliSessions: false,
    stopBackgroundTask: false,
    draftCommands: false,
  },
}
