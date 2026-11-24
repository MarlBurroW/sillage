import type { AgentInfo, CommandInfo, ModelInfo, SkillInfo } from '@sillage/opencode-bindings/v2'
import type { AgentSkillDto, SlashCommandDto } from '@sillage/protocol'
import type { OpencodeServer } from '../server.js'

/**
 * OpenCode 2 lists that fill after the server answers.
 *
 * A 2.x server loads a directory's context lazily: the first request for commands, skills, agents
 * or models returns an empty list and starts the load, which completes seconds later without any
 * stream event (probed 2.4.1: commands and skills about 3 s after the first request, models about
 * 1 s after start on a first run). Each list here has built-in entries (`init`, `review`…, the
 * `build` agent, the bundled skills), so empty means "not loaded yet" until the delay is spent.
 */

type Reader = Pick<OpencodeServer, 'get'>

/** How long a list may stay empty before it is believed. */
export const FILL_MS = 10_000

export async function readFilled<T>(server: Reader, path: string, fillMs = FILL_MS): Promise<T[]> {
  const deadline = Date.now() + fillMs
  for (;;) {
    const { data } = await server.get<{ data: T[] }>(path)
    if (data.length > 0 || Date.now() >= deadline) return data
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export const readModels2 = (server: Reader, fillMs?: number) => readFilled<ModelInfo>(server, '/api/model', fillMs)
export const readAgents2 = (server: Reader, fillMs?: number) => readFilled<AgentInfo>(server, '/api/agent', fillMs)
export const readCommands2 = (server: Reader, fillMs?: number) => readFilled<CommandInfo>(server, '/api/command', fillMs)
export const readSkills2 = (server: Reader, fillMs?: number) => readFilled<SkillInfo>(server, '/api/skill', fillMs)

/** 2.x commands carry no argument hints, and no longer include skills. */
export function toSlashCommands2(commands: CommandInfo[]): SlashCommandDto[] {
  return commands.map((command) => ({ name: command.name, description: command.description ?? '', argumentHint: '', aliases: [] }))
}

/**
 * 2.x skills are attached to a prompt by ID (`skills: [{id}]`) rather than run as slash commands
 * like on 1.x: Sillage offers them like Codex's `$` skills, the ID being the resolution key.
 */
export function toAgentSkills(skills: SkillInfo[]): AgentSkillDto[] {
  return skills.map((skill) => ({ name: skill.id, description: skill.description ?? skill.name }))
}
