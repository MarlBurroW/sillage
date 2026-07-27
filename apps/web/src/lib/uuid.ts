/**
 * `crypto.randomUUID` est réservé aux contextes sécurisés (https ou localhost).
 * Sillage est conçu pour être ouvert depuis un téléphone sur `http://<ip-locale>`,
 * qui n'en est pas un : l'appel direct y lève une TypeError.
 *
 * `crypto.getRandomValues`, lui, est disponible partout.
 */
export function uuidv4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // Version 4 et variante RFC 4122.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
