/**
 * opencode model is provider/model. Only first slash separates; model IDs often contain more
 * (openrouter/anthropic/claude…). Null for CLI-default sentinel or providerless string.
 */
export function parseModel(value: string): { providerID: string; modelID: string } | null {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}
