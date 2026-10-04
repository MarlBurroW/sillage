import { Document, isMap, parseDocument } from 'yaml'

/**
 * Lecture et écriture d'un `SKILL.md` : un frontmatter YAML entre deux lignes `---`,
 * puis le corps en markdown.
 *
 * Le frontmatter passe par un `Document` plutôt que par un objet : réécrire `name` ou
 * `description` doit laisser intacts les autres champs, leur ordre et leurs
 * commentaires. Un skill installé depuis un dépôt porte souvent des champs propres à un
 * CLI (`allowed-tools`, `metadata`…), qu'une réécriture ne doit pas perdre.
 */

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export interface SkillMarkdown {
  document: Document
  /** Le frontmatter en objet simple, pour la lecture. */
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
  // Un frontmatter vide se lit `null`, une liste ou un scalaire ne décrit pas un skill.
  if (document.contents !== null && !isMap(document.contents)) {
    throw new SkillMarkdownError('The frontmatter must be a mapping.')
  }

  const data = (document.toJS() ?? {}) as Record<string, unknown>
  // La ligne vide qui suit le frontmatter est une convention de mise en page, pas du
  // contenu : `serializeSkillMarkdown` la remet.
  return { document, data, body: text.slice(match[0].length).replace(/^\r?\n/, '') }
}

/**
 * Une ligne vide sépare le frontmatter du corps, comme dans les skills des dépôts
 * officiels. Elle n'appartient pas au corps, que `parseSkillMarkdown` rend sans elle :
 * relire puis réécrire un skill n'en ajoute donc pas une à chaque passage.
 */
export function serializeSkillMarkdown(document: Document, body: string): string {
  // `lineWidth: 0` : une description longue reste sur une ligne au lieu d'être pliée en
  // bloc, ce qui la garde lisible pour qui ouvre le fichier à la main.
  const frontmatter = document.toString({ lineWidth: 0 })
  return `---\n${frontmatter}---\n\n${body}`
}

/** Un `SKILL.md` neuf, `name` puis `description` en tête. */
export function newSkillMarkdown(name: string, description: string, body: string): string {
  const document = new Document({ name, description })
  return serializeSkillMarkdown(document, body)
}

/**
 * Réécrit des champs du frontmatter en gardant le reste. `undefined` laisse le champ tel
 * quel.
 */
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
