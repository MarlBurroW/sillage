/**
 * `crypto.randomUUID` requires secure contexts (HTTPS or loopback). Sillage supports phones on
 * local-IP HTTP, where calling it directly throws TypeError. `crypto.getRandomValues` is available
 * everywhere.
 */
export function uuidv4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // Version 4 and RFC 4122 variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
