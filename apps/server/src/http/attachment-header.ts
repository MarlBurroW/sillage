/**
 * Download `content-disposition` header, including the filename.
 *
 * Encoded according to RFC 5987 rather than inserted in quotes: an accented name
 * or one containing a quote would break the header, causing the browser to fall
 * back to a name derived from the URL.
 */
export function attachmentHeader(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename*=UTF-8''${encoded}`
}
