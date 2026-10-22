import { z } from 'zod'

/**
 * Slash commands recognized by the session's CLI.
 *
 * Not inferred from a catalog maintained here: each CLI publishes its own, and the list depends
 * on the machine and project as well as version. Dynamically discovered skills, project
 * commands and extension commands join without Sillage needing prior knowledge.
 */
export const slashCommandSchema = z.object({
  /** Without the slash, as named by the CLI. */
  name: z.string(),
  description: z.string(),
  /** Expected argument shape (`<file>`, `[on|off]`); empty when none. */
  argumentHint: z.string(),
  /** Aliases for the same command: `/cost` and `/stats` for `/usage`. */
  aliases: z.array(z.string()).default([]),
})

export type SlashCommandDto = z.infer<typeof slashCommandSchema>

/**
 * Commands recognized in a project directory, read before a conversation exists. Drafts offer
 * these after `/`; running threads receive their list through `commands.updated`.
 */
export interface ProjectCommandsDto {
  commands: SlashCommandDto[]
  fetchedAt: number
}

/**
 * Commands Sillage executes itself instead of forwarding as text.
 *
 * The CLI already supports them, but Sillage duplicated their paths for its own buttons. Using
 * that plumbing rather than typing gives identical visual feedback: the same compaction banner,
 * error and disabled button during the operation.
 */
export const NATIVE_SLASH_COMMANDS = new Set(['compact'])

/**
 * Commands removed from suggestions.
 *
 * Only three reasons: harness-internal commands (`__remote-workflow`); terminal-specific
 * commands Sillage cannot use (`color` repaints an absent composer, `heapdump` writes to the
 * server machine's desktop); or commands that change state Sillage tracks. `/clear` swaps the
 * CLI session without the journal knowing, while `/model`, `/effort`, `/fast`, `/output-style`,
 * `/advisor` and `/config` change applied configuration while composer settings still show the
 * old values.
 *
 * Commands duplicated by Sillage without conflict are not listed: `/usage` and `/context` reply
 * with text, and reading them twice causes no desynchronization.
 */
const HIDDEN_SLASH_COMMANDS = new Set([
  '__remote-workflow',
  'workflow-launch-exec',
  'color',
  'heapdump',
  'clear',
  'config',
  'model',
  'effort',
  'fast',
  'output-style',
  'advisor',
])

/**
 * CLI-advertised commands filtered to those meaningful in a browser.
 *
 * Applied at the source, before journaling: commands that cannot be offered need not travel or
 * be refiltered by every reader.
 *
 * Deprecated commands are detected through descriptions because there is no dedicated field:
 * the CLI keeps `/agents` and `/extra-usage` to redirect users still typing them, labeling them
 * “(removed)” and “Renamed to ...”. Offering them would suggest commands whose only response is
 * that they no longer exist.
 */
export function usableSlashCommands(commands: SlashCommandDto[]): SlashCommandDto[] {
  return commands.filter((command) => {
    if (HIDDEN_SLASH_COMMANDS.has(command.name)) return false
    if (command.name.startsWith('__')) return false
    return !/^\((removed|deprecated)\)|^Renamed to /i.test(command.description)
  })
}

/**
 * Command at the start of a message, if any.
 *
 * Only at the start: CLIs recognize it only there, and accepting `/` elsewhere would mistake a
 * path being typed for a command.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  return { name: match[1] ?? '', args: match[2]?.trim() ?? '' }
}
