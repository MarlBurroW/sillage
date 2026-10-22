/** Subsequence matching like command palettes: `wsx` matches `web/src/index.tsx`. Returns skipped-character count or null when letters are out of order. Consecutive letters cost nothing, so compact matches score lower. Final ranking belongs to callers because file paths and repository names use different tie-breaking cues. */
export function subsequenceGaps(haystack: string, needle: string): number | null {
  const target = haystack.toLowerCase()
  const query = needle.toLowerCase()

  let at = -1
  let gaps = 0
  for (const char of query) {
    const next = target.indexOf(char, at + 1)
    if (next === -1) return null
    if (at !== -1) gaps += next - at - 1
    at = next
  }
  return gaps
}
