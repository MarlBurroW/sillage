/**
 * Identité que Sillage annonce à `codex app-server` au `initialize`. Une seule
 * définition : elle était recopiée dans chaque appelant, et une divergence rendrait
 * les diagnostics côté CLI incohérents d'un canal à l'autre.
 */
export const CLIENT_INFO = { name: 'sillage', title: 'Sillage', version: '0.1.0' } as const
