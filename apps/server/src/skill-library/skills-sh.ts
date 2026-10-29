import { z } from 'zod'

/** Searches skills.sh, Vercel's directory. Its undocumented API was observed in `npx skills find` on 2026-10-04. Isolate it here with a tolerant schema: changed or unavailable responses yield null, hiding search rather than showing errors users cannot fix. */

const ENDPOINT = 'https://skills.sh/api/search'
const TIMEOUT_MS = 8000
const MAX_RESULTS = 20

const responseSchema = z.object({
  skills: z.array(
    z.object({
      source: z.string(),
      name: z.string(),
      skillId: z.string().optional(),
      installs: z.number().optional(),
    }),
  ),
})

export interface SkillsShResult {
  /** GitHub `owner/repo` form accepted by `normalizeSourceUrl`. */
  repository: string
  name: string
  installs: number
  slug: string
}

export async function searchSkillsSh(query: string): Promise<SkillsShResult[] | null> {
  try {
    const response = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const parsed = responseSchema.safeParse(await response.json())
    if (!parsed.success) return null
    return parsed.data.skills
      .filter((skill) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(skill.source))
      .slice(0, MAX_RESULTS)
      .map((skill) => ({ repository: skill.source, name: skill.name, slug: skill.skillId ?? skill.name, installs: skill.installs ?? 0 }))
  } catch {
    return null
  }
}

// Read only public metadata; discovery must never clone or register repositories.
const detailsCache = new Map<string, { until: number; value: Promise<string | null> }>()

export function skillsShDescription(repository: string, slug: string): Promise<string | null> {
  const key = repository + '/' + slug
  const cached = detailsCache.get(key)
  if (cached && cached.until > Date.now()) return cached.value
  const value = fetchDescription(repository, slug)
  if (detailsCache.size >= 200) detailsCache.delete(detailsCache.keys().next().value!)
  detailsCache.set(key, { until: Date.now() + 10 * 60_000, value })
  return value
}

async function fetchDescription(repository: string, slug: string): Promise<string | null> {
  try {
    const url = 'https://www.skills.sh/' + repository.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(slug)
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let html = ''
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 1_000_000) return null
        html += decoder.decode(value, { stream: true })
      }
    } finally {
      await reader.cancel()
    }
    for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const item: unknown = JSON.parse(match[1]!)
        const parsed = z.object({ '@type': z.literal('SoftwareApplication'), description: z.string().trim().min(1).max(20_000) }).safeParse(item)
        if (parsed.success) return parsed.data.description
      } catch { /* Other structured metadata may be malformed; keep looking. */ }
    }
    return null
  } catch {
    return null
  }
}
