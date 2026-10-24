import { usableSlashCommands, type SlashCommandDto } from '@sillage/protocol'
import { fields } from './content.js'

/** ACP commands normalized from ACP announcements. */
export function toSlashCommands(listed: unknown): SlashCommandDto[] {
  return usableSlashCommands((Array.isArray(listed) ? listed : []).flatMap((entry) => {
    const command = fields(entry)
    if (typeof command.name !== 'string' || !command.name) return []
    const hint = fields(command.input).hint
    return [{
      name: command.name,
      description: typeof command.description === 'string' ? command.description : '',
      argumentHint: typeof hint === 'string' ? hint : '',
      aliases: [],
    }]
  }))
}

