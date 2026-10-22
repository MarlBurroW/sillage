import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Actual launch command: executable and arguments preceding native arguments. */
export interface Launch {
  command: string
  args: string[]
}

/** Launching resolved `binary`: unchanged outside Windows. npm `.cmd` launchers require shells since Node's CVE-2024-27980 fix, but shell argument escaping is fragile. Read launcher targets instead: native Claude/OpenCode directly, JavaScript Codex through this process's Node bundled by desktop. */
export function launchOf(binary: string, platform: NodeJS.Platform = process.platform): Launch {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return { command: binary, args: [] }
  const content = readFileSync(binary, 'utf8')
  const target = npmShimTarget(binary, content)
  if (!target) {
    throw new Error(`Lanceur Windows non reconnu : ${binary}. Seuls les lanceurs écrits par npm sont pris en charge.`)
  }
  return runsThroughNode(content, target) ? { command: process.execPath, args: [target] } : { command: target, args: [] }
}

/** Claude SDK `pathToClaudeCodeExecutable`: SDK handles native executables and JavaScript via Node itself; only unusable `.cmd` wrappers require target resolution. */
export function sdkExecutable(binary: string, platform: NodeJS.Platform = process.platform): string {
  const launch = launchOf(binary, platform)
  return launch.args[0] ?? launch.command
}

/** Target of npm `.cmd` launchers, or null. Supports `cmd-shim` (`"%dp0%\…\codex.js" %*`) and Node's npm.cmd (`SET "NPM_CLI_JS=%~dp0\…\npm-cli.js"`). Last launcher-relative paths are targets; sibling node.exe is merely the preferred interpreter, npm-prefix.js preliminary npm logic. */
export function npmShimTarget(shim: string, content: string): string | null {
  const relatives = [...content.matchAll(/%~?dp0%?\\([^"\r\n%]+)/gi)]
    .map((match) => match[1]!)
    .filter((relative) => !/(^|\\)(node\.exe|npm-prefix\.js)$/i.test(relative))
  const relative = relatives.at(-1)
  return relative ? path.win32.join(path.win32.dirname(shim), relative) : null
}

/** Whether launchers pass targets to Node: always `.js`, or extensionless files invoked through `%_prog%` (cmd-shim Node) or `%NODE_EXE%` (Node npm.cmd). Grok's `bin/grok` is a Node-shebang script launching its native binary. */
function runsThroughNode(content: string, target: string): boolean {
  return /\.(c|m)?js$/i.test(target) || /%_prog%|%NODE_EXE%/i.test(content)
}
