/**
 * Un modèle opencode s'écrit `fournisseur/modèle`. Seule la première barre sépare :
 * l'identifiant du modèle en contient souvent d'autres (`openrouter/anthropic/claude…`).
 * Null pour la sentinelle « défaut du CLI » ou une chaîne sans fournisseur.
 */
export function parseModel(value: string): { providerID: string; modelID: string } | null {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}
