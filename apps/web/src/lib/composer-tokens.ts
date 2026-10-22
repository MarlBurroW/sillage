import type { AgentSkillDto, SlashCommandDto } from '@sillage/protocol'

/**
 * Entry suggested for the currently typed prefix. Slash commands and dollar skills differ in source
 * and effect but share selection behavior: normalize both here for a single list.
 */
export interface PickerEntry {
  /** Text inserted after the prefix when selected. */
  name: string
  /** Expected argument form, empty for entries without arguments. */
  hint: string
  summary: string
}

/**
 * First description line, the only part fitting a list row. A skill may explain activation over
 * several paragraphs, which would overwhelm neighboring short descriptions.
 */
function summarize(description: string): string {
  return description.split('\n')[0]?.trim() ?? ''
}

/**
 * Shared ordering: canonical names before aliases, then alphabetical. Discard CLI ordering, which
 * puts discovered skills before built-ins without meaning to browsing users.
 */
function byName(isCanonical: (entry: PickerEntry) => boolean) {
  return (a: PickerEntry, b: PickerEntry) => {
    const rank = Number(isCanonical(b)) - Number(isCanonical(a))
    return rank !== 0 ? rank : a.name.localeCompare(b.name)
  }
}

/**
 * Commands matching the typed prefix, nearest first. Use prefix matching rather than file-style
 * fuzzy search: names are short and known, while paths are searched. Aliases compete under their
 * own names so `/cost` finds `/usage` without knowing the canonical form.
 */
export function matchCommands(commands: SlashCommandDto[], query: string): PickerEntry[] {
  const needle = query.toLowerCase()
  const canonical = new Set<string>()
  const matches: PickerEntry[] = []

  for (const command of commands) {
    const names = [command.name, ...command.aliases]
    // Keep one name per command: listing `/usage`, `/cost`, and `/stats` separately would make one
    // command look like three.
    const name = names.find((candidate) => candidate.toLowerCase().startsWith(needle))
    if (!name) continue
    if (name === command.name) canonical.add(name)
    matches.push({ name, hint: command.argumentHint, summary: summarize(command.description) })
  }

  return matches.sort(byName((entry) => canonical.has(entry.name)))
}

/** Same prefix rule for skills, which have neither aliases nor arguments. */
export function matchSkills(skills: AgentSkillDto[], query: string): PickerEntry[] {
  const needle = query.toLowerCase()
  return skills
    .filter((skill) => skill.name.toLowerCase().startsWith(needle))
    .map((skill) => ({ name: skill.name, hint: '', summary: summarize(skill.description) }))
    .sort(byName(() => true))
}
