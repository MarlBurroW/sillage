/**
 * Téléchargement d'un contenu produit côté client.
 *
 * Passe par un objet URL plutôt que par une `data:` URI : celle-ci est plafonnée par
 * le navigateur, ce qu'un long bloc de code atteint sans mal.
 */
export function downloadText(filename: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Encode une ligne au format CSV (RFC 4180).
 *
 * Le guillemet, la virgule et le retour à la ligne imposent d'entourer le champ, et
 * le guillemet se double à l'intérieur. Sans ça, une cellule contenant une virgule
 * décale toutes les colonnes suivantes.
 */
export function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(','),
    )
    .join('\r\n')
}
