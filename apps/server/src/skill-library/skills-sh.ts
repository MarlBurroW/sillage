import { z } from 'zod'

/**
 * Recherche sur skills.sh, l'annuaire de Vercel.
 *
 * Son API n'est pas documentée : c'est celle qu'interroge `npx skills find`, relevée le
 * 2026-10-04. Tout est donc isolé ici et lu par un schéma tolérant. Si la réponse change
 * de forme ou n'arrive pas, la fonction rend null, et l'interface masque la recherche
 * plutôt que d'afficher une erreur que l'utilisateur ne peut pas corriger.
 */

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
  /** `owner/repo` sur GitHub, la forme que `normalizeSourceUrl` accepte. */
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
