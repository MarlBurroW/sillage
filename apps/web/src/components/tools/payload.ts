/**
 * Lecture des payloads d'outils.
 *
 * Ces payloads traversent le journal sans schéma (I3 ne normalise que l'enveloppe, pas
 * ce que chaque outil met dedans) : un renderer ne peut rien tenir pour acquis, ni la
 * présence d'un champ, ni son type. Ces accesseurs rendent `null` au lieu de lever, ce
 * qui laisse au renderer le choix de se rabattre sur la vue brute plutôt que de casser
 * le fil entier.
 */

export function fields(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function text(value: unknown, key: string): string | null {
  const found = fields(value)?.[key]
  return typeof found === 'string' && found.length > 0 ? found : null
}

/** Une valeur simple ramenée à son affichage, quel que soit son type d'origine. */
export function scalar(value: unknown, key: string): string | null {
  const found = fields(value)?.[key]
  if (typeof found === 'number' || typeof found === 'boolean') return String(found)
  return typeof found === 'string' && found.length > 0 ? found : null
}

export function flag(value: unknown, key: string): boolean {
  return fields(value)?.[key] === true
}

export function list(value: unknown, key: string): unknown[] | null {
  const found = fields(value)?.[key]
  return Array.isArray(found) ? found : null
}

/**
 * La sortie d'un appel ramenée à du texte.
 *
 * Claude Code rend le contenu d'un `tool_result`, qui est soit une chaîne, soit une
 * suite de blocs dont seuls les blocs texte nous intéressent (une image de capture
 * d'écran n'a rien à faire dans un `<pre>`). Codex rend directement la sortie agrégée
 * de la commande. Tout le reste n'est pas du texte et rend `null` : c'est le signal
 * qu'il faut une vue spécialisée, ou la vue brute.
 */
export function outputText(output: unknown): string | null {
  if (typeof output === 'string') return output

  if (Array.isArray(output)) {
    const parts = output
      .map((block) => text(block, 'text'))
      .filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join('\n') : null
  }

  return null
}

/** Lignes non vides d'une sortie, pour les outils qui en produisent une par résultat. */
export function outputLines(output: unknown): string[] | null {
  const raw = outputText(output)
  if (raw === null) return null
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  return lines.length > 0 ? lines : null
}

/** `     12\tcontenu` : la gouttière que `cat -n` place devant chaque ligne. */
const GUTTER = /^\s*\d+\t/

/**
 * Retire le numérotage que Claude Code ajoute au contenu qu'il lit, et rend `null`
 * si la sortie n'en porte pas.
 *
 * Toutes les lignes doivent le porter : une sortie où seules quelques-unes commencent
 * par un nombre n'est pas numérotée, elle parle de nombres. Ce numérotage est un
 * artefact d'affichage du CLI, pas le contenu du fichier ; le laisser empêche de
 * colorer le code et de le copier tel quel. La vue brute, elle, le conserve.
 */
export function stripLineNumbers(content: string): string | null {
  const lines = content.split('\n')
  const numbered = lines.filter((line) => line.length > 0)
  if (numbered.length === 0 || !numbered.every((line) => GUTTER.test(line))) return null
  return lines.map((line) => line.replace(GUTTER, '')).join('\n')
}
