/** Route shared by UI, notifications and agent links; personal sessions have no project segment. */
export function conversationPath(session: { id: string; projectId: string | null }): string {
  return session.projectId ? `/p/${session.projectId}/c/${session.id}` : `/discussions/${session.id}`
}

/** Stable across renames, archives, and Server/Desktop addresses. */
export function sessionReference(id: string): string {
  return `session:${id}`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export interface SessionReferenceRange {
  start: number
  end: number
  id: string
  /** Bare UUIDs become links only after confirming they name an accessible session. */
  explicit: boolean
  projectId?: string
}

/**
 * Consume URLs as whole tokens, including foreign ones: their UUIDs must never accidentally link
 * to local sessions. Callers supply the current origin when accepting copied browser addresses.
 */
export function sessionReferenceRanges(text: string, origin?: string): SessionReferenceRange[] {
  const pattern = new RegExp(`https?://[^\\s<>"\`]+|/p/${UUID}/c/${UUID}(?:[?#][^\\s<>"\`]*)?|/discussions/${UUID}(?:[?#][^\\s<>"\`]*)?|session:${UUID}|${UUID}`, 'gi')
  const ranges: SessionReferenceRange[] = []
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    const value = match[0]
    if (start > 0 && /[\w/:-]/.test(text[start - 1]!)) continue
    if ((value.startsWith('/p/') || value.startsWith('/discussions/')) && /[\w/-]/.test(text[start + value.length] ?? '')) continue
    if (/^https?:/i.test(value) || (value.startsWith('/p/') || value.startsWith('/discussions/'))) {
      const clean = value.replace(/[),.;!?]+$/, '')
      const address = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(clean)
      const normalizeOrigin = (value: string) => value.toLowerCase().replace(/\/+$/, '').replace(/^(https:.*):443$/, '$1').replace(/^(http:.*):80$/, '$1')
      if (address && (!origin || normalizeOrigin(address[1]!) !== normalizeOrigin(origin))) continue
      const pathname = address ? address[2] : clean.split(/[?#]/)[0]
      const route = new RegExp(`^/p/(${UUID})/c/(${UUID})/?$`, 'i').exec(pathname ?? '')
      const personal = new RegExp(`^/discussions/(${UUID})/?$`, 'i').exec(pathname ?? '')
      if (personal) ranges.push({ start, end: start + clean.length, id: personal[1]!.toLowerCase(), explicit: true })
      if (route) ranges.push({ start, end: start + clean.length, id: route[2]!.toLowerCase(), projectId: route[1]!.toLowerCase(), explicit: true })
      continue
    }
    if (/[\w-]/.test(text[start + value.length] ?? '')) continue
    const explicit = value.toLowerCase().startsWith('session:')
    ranges.push({ start, end: start + value.length, id: (explicit ? value.slice(8) : value).toLowerCase(), explicit })
  }
  return ranges
}

/** Session completion is separate from file mentions and accepts multiword title searches. */
export function sessionMentionAt(value: string, caret: number): { query: string; start: number; end: number } | null {
  const match = /(?:^|\s)@@([^@\n]*)$/.exec(value.slice(0, caret))
  return match ? { query: match[1] ?? '', start: caret - (match[1]?.length ?? 0) - 2, end: caret } : null
}
