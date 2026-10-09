import { basename, dirname } from 'node:path'

/**
 * La ligne de commande telle que l'utilisateur la reconnaît : ce qu'il a tapé ou ce
 * que l'agent a demandé, sans l'enrobage du CLI ni les chemins d'installation, et
 * sans les valeurs qui ressemblent à un secret. C'est la seule forme qui sort du
 * serveur ; l'environnement et les arguments bruts n'en sortent jamais.
 */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])
export const COMMAND_LIMIT = 160

/** `zsh -c …`, `bash -lc …` : le porteur d'une commande, pas la commande. */
export function isShellCommand(argv: readonly string[]): boolean {
  return SHELLS.has(basename(argv[0] ?? '')) && /^-[A-Za-z]*c[A-Za-z]*$/.test(argv[1] ?? '') && !!argv[2]
}

/**
 * Claude Code enrobe chaque commande : restauration de l'environnement, `eval '…'`,
 * parfois `< /dev/null` pour une tâche de fond, puis sauvegarde du dossier courant.
 * Seule la commande évaluée intéresse ; ses apostrophes y sont doublées en '"'"'.
 */
function unwrapAgentShell(script: string): string {
  const evaluated = /(?:^|&&\s*)eval '([\s\S]*)'(?:\s*<\s*\S+)?(?:\s*&&\s*pwd -P >\|?\s*\S+)?\s*$/.exec(script)?.[1]
  return evaluated ? evaluated.replaceAll(`'"'"'`, "'") : script
}

/** Mots de passe d'URL, en-têtes d'autorisation, jetons et clés passés en argument. */
const SECRETS: [RegExp, string][] = [
  [/(:\/\/[^\s/:@]+:)[^\s@/]+@/g, '$1…@'],
  [/(authorization\s*[=:]\s*["']?(?:bearer|basic|token)?\s*)[^\s"']+/gi, '$1…'],
  [/((?:^|[\s"'=(])(?:bearer|basic)\s+)[^\s"']+/gi, '$1…'],
  [/([\w.-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w.-]*\s*[=:]\s*["']?)[^\s"']+/gi, '$1…'],
]

export function redactSecrets(text: string): string {
  return SECRETS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}

/** Un exécutable pris dans un répertoire de binaires s'identifie par son nom seul. */
function shortenArgument(argument: string): string {
  return argument.startsWith('/') && /\/\.?bin$/.test(dirname(argument)) ? basename(argument) : argument
}

export function summarizeCommand(argv: readonly string[], home = process.env.HOME ?? ''): string | null {
  // Un programme qui réécrit son titre (Chrome, `npm exec`) laisse une seule chaîne, espaces compris.
  if (argv.length === 1 && /\s/.test(argv[0]!)) argv = argv[0]!.split(/\s+/)
  if (!argv.length) return null
  let text = isShellCommand(argv)
    ? unwrapAgentShell(argv[2]!)
    : [basename(argv[0]!), ...argv.slice(1).map(shortenArgument)].join(' ')
  if (home) text = text.replaceAll(`${home}/`, '~/').replaceAll(home, '~')
  text = redactSecrets(text.replace(/\s+/g, ' ').trim())
  return text.length > COMMAND_LIMIT ? `${text.slice(0, COMMAND_LIMIT - 1)}…` : text
}
