import { Document, isMap, parseDocument } from 'yaml'

/** Reads and writes `SKILL.md`: YAML frontmatter between `---` lines followed by Markdown. Use a `Document` rather than an object so changes to `name` or `description` preserve other fields, their order and comments. Repository-installed skills often contain CLI-specific fields (`allowed-tools`, `metadata`…) that rewrites must retain. */

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export interface SkillMarkdown {
  document: Document
  /** Frontmatter as a plain object for reads. */
  data: Record<string, unknown>
  body: string
}

export class SkillMarkdownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillMarkdownError'
  }
}

export function parseSkillMarkdown(text: string): SkillMarkdown {
  const match = FENCE.exec(text)
  if (!match) throw new SkillMarkdownError('SKILL.md has no frontmatter.')

  const document = parseDocument(match[1]!)
  if (document.errors.length > 0) {
    throw new SkillMarkdownError(`Invalid frontmatter: ${document.errors[0]!.message}`)
  }
  // Empty frontmatter reads as `null`; lists and scalars do not describe skills.
  if (document.contents !== null && !isMap(document.contents)) {
    throw new SkillMarkdownError('The frontmatter must be a mapping.')
  }

  const data = (document.toJS() ?? {}) as Record<string, unknown>
  // The blank line after frontmatter is layout convention rather than
  // content; serializeSkillMarkdown restores it.
  return { document, data, body: text.slice(match[0].length).replace(/^\r?\n/, '') }
}

/** One blank line separates frontmatter from body, matching official repository skills. It is excluded from the body returned by `parseSkillMarkdown`, so read/write cycles do not add a new line each time. */
export function serializeSkillMarkdown(document: Document, body: string): string {
  // `lineWidth: 0` keeps long descriptions on one line rather than folded blocks,
  // preserving readability when opening files manually.
  const frontmatter = document.toString({ lineWidth: 0 })
  return `---\n${frontmatter}---\n\n${body}`
}

/** New `SKILL.md` with `name` then `description` first. */
export function newSkillMarkdown(name: string, description: string, body: string): string {
  const document = new Document({ name, description })
  return serializeSkillMarkdown(document, body)
}

/** Rewrites frontmatter fields while retaining everything else. `undefined` leaves fields unchanged. */
export function updateSkillMarkdown(
  text: string,
  changes: { name?: string; description?: string; body?: string },
): string {
  const parsed = parseSkillMarkdown(text)
  if (parsed.document.contents === null) parsed.document.contents = parsed.document.createNode({})
  if (changes.name !== undefined) parsed.document.set('name', changes.name)
  if (changes.description !== undefined) parsed.document.set('description', changes.description)
  return serializeSkillMarkdown(parsed.document, changes.body ?? parsed.body)
}
