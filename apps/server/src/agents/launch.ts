import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Ce qu'il faut réellement lancer : un exécutable, et les arguments qui précèdent les siens. */
export interface Launch {
  command: string
  args: string[]
}

/**
 * Comment lancer le CLI résolu en `binary`.
 *
 * Ailleurs que sous Windows, tel quel. Sous Windows, npm expose ses CLI par des lanceurs
 * `.cmd`, que Node refuse de lancer sans shell depuis le correctif de la CVE-2024-27980,
 * et qu'un shell lancerait au prix d'un échappement fragile des arguments. On lit donc le
 * lanceur pour retrouver sa cible : un exécutable natif (Claude Code, OpenCode) se lance
 * directement, un script JavaScript (Codex) par le Node de ce processus, celui que l'app
 * de bureau embarque.
 */
export function launchOf(binary: string, platform: NodeJS.Platform = process.platform): Launch {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return { command: binary, args: [] }
  const content = readFileSync(binary, 'utf8')
  const target = npmShimTarget(binary, content)
  if (!target) {
    throw new Error(`Lanceur Windows non reconnu : ${binary}. Seuls les lanceurs écrits par npm sont pris en charge.`)
  }
  return runsThroughNode(content, target) ? { command: process.execPath, args: [target] } : { command: target, args: [] }
}

/**
 * Le chemin à donner au SDK de Claude comme `pathToClaudeCodeExecutable`.
 *
 * Le SDK lance lui-même un exécutable natif, et un script JavaScript par Node : seul un
 * lanceur `.cmd` lui est inutilisable, d'où sa cible à la place.
 */
export function sdkExecutable(binary: string, platform: NodeJS.Platform = process.platform): string {
  const launch = launchOf(binary, platform)
  return launch.args[0] ?? launch.command
}

/**
 * La cible d'un lanceur `.cmd` écrit par npm, ou null.
 *
 * Deux formes : celle du paquet `cmd-shim`, pour les CLI installés (`"%dp0%\…\codex.js"
 * %*`), et le `npm.cmd` livré avec Node (`SET "NPM_CLI_JS=%~dp0\…\npm-cli.js"`). Dans les
 * deux, la cible est le dernier chemin relatif au dossier du lanceur ; un `node.exe` posé
 * à côté n'est que l'interpréteur qu'il préférerait, et `npm-prefix.js` un calcul préalable
 * de npm.
 */
export function npmShimTarget(shim: string, content: string): string | null {
  const relatives = [...content.matchAll(/%~?dp0%?\\([^"\r\n%]+)/gi)]
    .map((match) => match[1]!)
    .filter((relative) => !/(^|\\)(node\.exe|npm-prefix\.js)$/i.test(relative))
  const relative = relatives.at(-1)
  return relative ? path.win32.join(path.win32.dirname(shim), relative) : null
}

/**
 * Le lanceur passe-t-il sa cible à Node ? Un script `.js` toujours ; un fichier sans
 * extension quand le lanceur le confie à `%_prog%` (le Node que `cmd-shim` choisit) ou à
 * `%NODE_EXE%` (le `npm.cmd` de Node). C'est le cas de Grok, dont `bin/grok` est un script
 * à shebang node qui lance ensuite le binaire natif.
 */
function runsThroughNode(content: string, target: string): boolean {
  return /\.(c|m)?js$/i.test(target) || /%_prog%|%NODE_EXE%/i.test(content)
}
