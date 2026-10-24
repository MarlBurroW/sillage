/** Codex can reveal web arguments only in the completed item. Keep all action fields. */
export function codexWebSearchInput(query: string, action: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ...action,
    // A nullable action.query must not erase the item's available query.
    query: typeof action?.query === 'string' && action.query.trim() ? action.query : query,
  }
}
