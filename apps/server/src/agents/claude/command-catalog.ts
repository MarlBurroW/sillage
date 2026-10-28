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
 * Slash commands recognized in directory without session.
 *
 * Runner publishes at first turn, but draft has none: probe supplies completion.
 * Directory-dependent project commands (`.claude/commands`, skills) require per-directory cache.
 *
 * Probe sees subset of future thread commands: MCP prompts (`/mcp__<server>__<prompt>`) require
 * conversation configuration. Use strictMcpConfig without servers to avoid advertising machine
 * ~/.claude.json servers thread would reject.
 */

const CACHE_TTL_MS = 5 * 60 * 1000

export class ClaudeCommandCatalog {
  private readonly probes = new CachedProbeMap<{ commands: SlashCommandDto[] }>(
    CACHE_TTL_MS,
    (cwd) => this.probe(cwd),
    (cwd) => resolve(cwd),
  )

  constructor(private readonly executable: () => Promise<string>) {}

  invalidate(): void { this.probes.invalidate() }

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

/** Same formatting as runner: draft offers what thread will offer. */
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
