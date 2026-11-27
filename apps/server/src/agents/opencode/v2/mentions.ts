/**
 * Sub-agents @-mentioned in a 2.x prompt, as `POST …/prompt {agents}` records them.
 *
 * Like the TUI, `@explore` in the text names the `explore` sub-agent: opencode passes only the
 * text to the model, as a suggestion to delegate, and keeps the attachment to say which agent the
 * mention names (2.4.2 description of `Prompt.AgentAttachment`). The text decides, so a mention
 * typed by hand counts like a picked one. A file mentioned under the same name stays a file.
 */
export interface AgentMention {
  name: string
  mention: { start: number; end: number; text: string }
}

export function agentMentions(text: string, agents: Iterable<string>, files: Iterable<string> = []): AgentMention[] {
  const names = new Set(agents)
  for (const file of files) names.delete(file)
  if (!names.size) return []
  const found: AgentMention[] = []
  // A word start, as the composer opens @ completion; closing punctuation is not the name's.
  for (const match of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const name = match[2]!.replace(/[.,;:!?)\]}'"]+$/, '')
    if (!names.has(name)) continue
    const start = match.index + match[1]!.length
    found.push({ name, mention: { start, end: start + name.length + 1, text: `@${name}` } })
  }
  return found
}
