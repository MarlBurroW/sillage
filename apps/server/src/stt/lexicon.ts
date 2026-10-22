import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Project dictation lexicon in two forms. `spoken` goes to Whisper's roughly 224-token `prompt`, using natural transcript-like sentences rather than lists. `written` feeds cleanup without that limit and provides exact spellings (`vite.config.ts`, `@scope/pkg`). */
export interface Lexicon {
  spoken: string
  written: string[]
}

/** Project description sources without digging through code. */
const SOURCES = [
  'CLAUDE.md',
  'AGENTS.md',
  'README.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
]

const MAX_SOURCE_CHARS = 4000
const MAX_SPOKEN_CHARS = 600

interface CachedLexicon {
  fingerprint: string
  lexicon: Lexicon | null
}

/** Memory-only cache: generation is fast and inexpensive, so regenerate on first use after restart. Cache failures too, preventing every dictation from retrying a provider that just rejected us. */
const cache = new Map<string, CachedLexicon>()

export type ChatCall = (system: string, user: string) => Promise<string>

/** Project lexicon regenerated when sources change. `null` for undescribed workspaces or generation failure: unbiased dictation is still preferable to blocking. */
export async function projectLexicon(
  projectId: string,
  workspacePath: string,
  chat: ChatCall,
): Promise<Lexicon | null> {
  const sources = await readSources(workspacePath)
  if (sources.length === 0) return null

  const fingerprint = sources.map((s) => `${s.name}:${s.mtimeMs}:${s.size}`).join('|')
  const cached = cache.get(projectId)
  if (cached && cached.fingerprint === fingerprint) return cached.lexicon

  const lexicon = await generate(sources, workspacePath, chat).catch(() => null)
  cache.set(projectId, { fingerprint, lexicon })
  return lexicon
}

interface Source {
  name: string
  content: string
  mtimeMs: number
  size: number
}

async function readSources(workspacePath: string): Promise<Source[]> {
  const found: Source[] = []
  for (const name of SOURCES) {
    const path = join(workspacePath, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    const content = await readFile(path, 'utf8').catch(() => null)
    if (content === null) continue
    found.push({
      name,
      content: content.slice(0, MAX_SOURCE_CHARS),
      mtimeMs: info.mtimeMs,
      size: info.size,
    })
  }
  return found
}

async function generate(
  sources: Source[],
  workspacePath: string,
  chat: ChatCall,
): Promise<Lexicon | null> {
  const entries = await readdir(workspacePath, { withFileTypes: true }).catch(() => [])
  const tree = entries
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .slice(0, 60)
    .join(' ')

  const system = [
    'You build a dictation glossary for a software project: the terms a developer is',
    'likely to say out loud while dictating prompts about it, and that generic',
    'speech-to-text would garble.',
    'Answer with JSON only, no markdown fence, with exactly two fields:',
    '- "spoken": one natural French sentence of at most 60 words that mentions the',
    '  project name and its notable technologies, tools and domain words, written the',
    '  way they are pronounced. No file paths in it.',
    '- "written": an array of up to 40 exact spellings worth restoring in a transcript:',
    '  identifiers, file names, package names, commands.',
    'Only include terms grounded in the provided material.',
  ].join('\n')

  const user = [
    `Top-level entries: ${tree}`,
    ...sources.map((source) => `--- ${source.name} ---\n${source.content}`),
  ].join('\n\n')

  const raw = await chat(system, user)
  return parseLexicon(raw)
}

/** Tolerant parsing: not all providers enforce JSON and verbose models may wrap responses. Extract the first plausible object. */
function parseLexicon(raw: string): Lexicon | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }

  const { spoken, written } = parsed as { spoken?: unknown; written?: unknown }
  if (typeof spoken !== 'string' || spoken.trim().length === 0) return null
  return {
    spoken: spoken.trim().slice(0, MAX_SPOKEN_CHARS),
    written: Array.isArray(written)
      ? written.filter((term): term is string => typeof term === 'string').slice(0, 40)
      : [],
  }
}
