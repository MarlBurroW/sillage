/**
 * En-tête `content-disposition` d'un téléchargement, nom compris.
 *
 * Encodé selon la RFC 5987 plutôt que glissé entre guillemets : un nom accentué ou qui
 * contient un guillemet casserait l'en-tête, et le navigateur retomberait sur un nom
 * tiré de l'URL.
 */
export function attachmentHeader(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename*=UTF-8''${encoded}`
}
