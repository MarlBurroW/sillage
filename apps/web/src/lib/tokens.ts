/**
 * Shortest readable token count. The context gauge keeps its own integer version: its
 * fourteen-pixel circle cannot fit decimal counts.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)} k`
  return `${(count / 1_000_000).toFixed(1)} M`
}
