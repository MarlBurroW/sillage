import { basename, dirname } from 'node:path'

/** User-recognizable command line: what they typed or the agent requested, without CLI wrappers or installation paths, and with secret-like values removed. Only this form leaves the server; environments and raw arguments never do. */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])
export const COMMAND_LIMIT = 160

/** `zsh -c …`, `bash -lc …`: command carriers rather than the command itself. */
export function isShellCommand(argv: readonly string[]): boolean {
  return SHELLS.has(basename(argv[0] ?? '')) && /^-[A-Za-z]*c[A-Za-z]*$/.test(argv[1] ?? '') && !!argv[2]
}

/** Claude Code wraps commands with environment restoration, `eval '…'`, sometimes `< /dev/null` for background tasks, then cwd saving. Only the evaluated command matters; its apostrophes are escaped as '\"'\"'. */
function unwrapAgentShell(script: string): string {
  const evaluated = /(?:^|&&\s*)eval '([\s\S]*)'(?:\s*<\s*\S+)?(?:\s*&&\s*pwd -P >\|?\s*\S+)?\s*$/.exec(script)?.[1]
  return evaluated ? evaluated.replaceAll(`'"'"'`, "'") : script
}

/** URL passwords, authorization headers, tokens and keys supplied as arguments. */
const SECRETS: [RegExp, string][] = [
  [/(:\/\/[^\s/:@]+:)[^\s@/]+@/g, '$1…@'],
  [/(authorization\s*[=:]\s*["']?(?:bearer|basic|token)?\s*)[^\s"']+/gi, '$1…'],
  [/((?:^|[\s"'=(])(?:bearer|basic)\s+)[^\s"']+/gi, '$1…'],
  [/([\w.-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w.-]*\s*[=:]\s*["']?)[^\s"']+/gi, '$1…'],
]

export function redactSecrets(text: string): string {
  return SECRETS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}

/** Executables under binary directories are identified by basename alone. */
function shortenArgument(argument: string): string {
  return argument.startsWith('/') && /\/\.?bin$/.test(dirname(argument)) ? basename(argument) : argument
}

export function summarizeCommand(argv: readonly string[], home = process.env.HOME ?? ''): string | null {
  // Programs rewriting their process title (Chrome, `npm exec`) leave one string including spaces.
  if (argv.length === 1 && /\s/.test(argv[0]!)) argv = argv[0]!.split(/\s+/)
  if (!argv.length) return null
  let text = isShellCommand(argv)
    ? unwrapAgentShell(argv[2]!)
    : [basename(argv[0]!), ...argv.slice(1).map(shortenArgument)].join(' ')
  if (home) text = text.replaceAll(`${home}/`, '~/').replaceAll(home, '~')
  text = redactSecrets(text.replace(/\s+/g, ' ').trim())
  return text.length > COMMAND_LIMIT ? `${text.slice(0, COMMAND_LIMIT - 1)}…` : text
}
