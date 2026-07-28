/**
 * Un nombre de tokens, au plus court qui reste lisible.
 *
 * La jauge de contexte garde sa propre version, sans décimale : elle écrit dans un
 * cercle de quatorze pixels, où « 12,3 k » ne tient pas.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)} k`
  return `${(count / 1_000_000).toFixed(1)} M`
}
