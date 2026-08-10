/**
 * Fraîcheur d'une lecture de consommation, la même pour tous les CLI.
 *
 * Le cache est ici le seul garde-fou : une lecture démarre un process CLI, et la page
 * de brouillon la demande à chaque ouverture, sans que personne ait cliqué. Cinq
 * minutes suffisent pour qu'ouvrir une conversation ne coûte qu'un aller-retour HTTP,
 * sans qu'une jauge devienne fausse au point de tromper. Le bouton de rafraîchissement
 * du panneau court-circuite ce cache quand la valeur exacte importe.
 */
export const USAGE_CACHE_TTL_MS = 300_000
