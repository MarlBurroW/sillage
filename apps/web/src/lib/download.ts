/**
 * Download client-generated content through object URLs rather than data URIs, whose browser size
 * limits are easily reached by long code blocks.
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
 * Encode a CSV row (RFC 4180). Quotes, commas, and newlines require enclosing the field, with
 * doubled internal quotes. Otherwise a comma-containing cell shifts every subsequent column.
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
