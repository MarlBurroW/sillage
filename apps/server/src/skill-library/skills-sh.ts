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
      installs: z.number().optional(),
    }),
  ),
})

export interface SkillsShResult {
  /** GitHub `owner/repo` form accepted by `normalizeSourceUrl`. */
  repository: string
  name: string
  installs: number
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
      .map((skill) => ({ repository: skill.source, name: skill.name, installs: skill.installs ?? 0 }))
  } catch {
    return null
  }
}
