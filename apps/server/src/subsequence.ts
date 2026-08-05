/**
 * Correspondance par sous-séquence, à la façon des palettes de commandes : `wsx`
 * retrouve `web/src/index.tsx`.
 *
 * Renvoie le nombre de caractères sautés entre les lettres trouvées, ou null si elles
 * n'apparaissent pas dans l'ordre. Les lettres consécutives ne coûtent rien, donc une
 * correspondance compacte donne un total plus bas.
 *
 * Le classement final n'est pas ici : ce qui départage deux correspondances aussi
 * compactes dépend de ce qu'on cherche, un chemin de fichier et un nom de dépôt n'ayant
 * pas les mêmes repères.
 */
export function subsequenceGaps(haystack: string, needle: string): number | null {
  const target = haystack.toLowerCase()
  const query = needle.toLowerCase()

  let at = -1
  let gaps = 0
  for (const char of query) {
    const next = target.indexOf(char, at + 1)
    if (next === -1) return null
    if (at !== -1) gaps += next - at - 1
    at = next
  }
  return gaps
}
