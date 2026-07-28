import type { AgentKind } from './events.js'

/**
 * Le paquet npm de chaque CLI, et la version que cette release de Sillage vise.
 *
 * Sillage ne transporte plus les binaires : ils viennent du système, donc leur version
 * n'est plus figée par la release et les écarts de comportement deviennent visibles pour
 * l'utilisateur. Ce tableau est ce à quoi on compare, pour pouvoir le dire plutôt que de
 * le subir.
 *
 * « Préférée » et non « testée » : on ne vérifie pas chaque version de chaque CLI, et
 * prétendre le contraire ferait passer pour garanti ce qui ne l'est pas. C'est la version
 * sur laquelle Sillage est développé, celle que l'installation posera, et celle dont on
 * s'écarte à ses risques.
 *
 * À bumper délibérément. Un numéro qu'on relève sans regarder ne vaut pas mieux que pas
 * de numéro du tout.
 *
 * Une seule table plutôt que deux : le paquet et la version qu'on en attend sont le même
 * fait, et les séparer les laisserait diverger au premier bump.
 */
export interface PreferredCliRelease {
  /** Paquet npm, tel que l'installation depuis l'interface le posera. */
  readonly package: string
  readonly version: string
}

export const PREFERRED_CLI_RELEASES: Record<AgentKind, PreferredCliRelease> = {
  claude: { package: '@anthropic-ai/claude-code', version: '2.1.220' },
  codex: { package: '@openai/codex', version: '0.145.0' },
}

interface Parsed {
  major: number
  minor: number
  patch: number
}

/** Null quand la chaîne n'a pas de tête de version : un CLI peut répondre n'importe quoi. */
function parse(version: string): Parsed | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

function compare(a: Parsed, b: Parsed): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * La version installée est-elle compatible avec celle que Sillage vise ?
 *
 * Sémantique du caret npm, plutôt qu'une règle inventée ici : c'est déjà celle que
 * l'écosystème applique, et elle épouse les deux façons de versionner qu'on rencontre.
 * Claude publie des centaines de correctifs sous une même mineure (189 pour la seule
 * 2.1), donc comparer la mineure ne signalerait jamais rien ; Codex est en 0.x et change
 * de mineure toutes les quelques semaines, donc la même comparaison hurlerait en
 * permanence. Le caret traite les deux correctement, parce que pour un 0.y.z la mineure
 * *est* le segment cassant.
 *
 * Deux bornes, donc : pas plus ancienne que la version visée, et sans avoir franchi la
 * limite cassante au-dessus.
 *
 * Null quand l'une des deux ne se lit pas : sans comparaison possible, on n'affirme rien.
 */
export function isCompatibleVersion(installed: string, preferred: string): boolean | null {
  const a = parse(installed)
  const b = parse(preferred)
  if (!a || !b) return null
  if (compare(a, b) < 0) return false
  // Le plafond : même majeure, et pour les 0.x aussi la même mineure. Le test sur la
  // majeure vaut dans les deux cas, sans quoi une 1.145 passerait pour compatible avec
  // une 0.145 sur la seule foi de la mineure.
  return a.major === b.major && (b.major > 0 || a.minor === b.minor)
}
