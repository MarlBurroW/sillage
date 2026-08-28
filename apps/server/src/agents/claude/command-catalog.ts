import { resolve } from 'node:path'
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import {
  usableSlashCommands,
  type ProjectCommandsDto,
  type SlashCommandDto,
} from '@sillage/protocol'
import { CachedProbeMap } from '../cached-probe.js'
import { withControlSession } from './control-session.js'

/**
 * Commandes en `/` que le CLI reconnaît dans un dossier donné, sans session.
 *
 * Le runner publie cette liste au premier tour, mais le brouillon d'une conversation
 * n'a pas encore de tour : c'est ici qu'il vient chercher de quoi proposer. La liste
 * dépend du dossier (commandes de projet sous `.claude/commands`, compétences), d'où
 * un cache par répertoire plutôt qu'un seul pour le daemon.
 *
 * Ce que la sonde voit est un sous-ensemble de ce que le fil publiera : les prompts
 * des serveurs MCP apparaissent comme des commandes `/mcp__<serveur>__<prompt>`, et
 * ces serveurs ne sont connus qu'à la création de la conversation, avec sa
 * configuration. La sonde tourne donc en `strictMcpConfig` sans aucun serveur,
 * pour ne pas non plus annoncer ceux du `~/.claude.json` de la machine, que le fil
 * refuserait ensuite.
 */

const CACHE_TTL_MS = 5 * 60 * 1000

export class ClaudeCommandCatalog {
  private readonly probes = new CachedProbeMap<{ commands: SlashCommandDto[] }>(
    CACHE_TTL_MS,
    (cwd) => this.probe(cwd),
    (cwd) => resolve(cwd),
  )

  constructor(private readonly executable: () => Promise<string>) {}

  list(cwd: string, force = false): Promise<ProjectCommandsDto> {
    return this.probes.read(cwd, force)
  }

  private probe(cwd: string): Promise<{ commands: SlashCommandDto[] }> {
    return withControlSession(
      {
        executable: this.executable,
        cwd,
        tag: 'commands',
        options: { mcpServers: {}, strictMcpConfig: true },
      },
      async (session) => ({ commands: toDto(await session.supportedCommands()) }),
    )
  }
}

/** Même mise en forme que le runner : ce que le brouillon propose est ce que le fil proposera. */
export function toDto(commands: SlashCommand[]): SlashCommandDto[] {
  return usableSlashCommands(
    commands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      aliases: command.aliases ?? [],
    })),
  )
}
