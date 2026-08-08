import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Lexique de dictée d'un projet, sous ses deux formes.
 *
 * `spoken` part dans le paramètre `prompt` de Whisper, qui n'accepte qu'environ 224
 * tokens et cale son vocabulaire sur du texte qui sonne comme une transcription : une
 * phrase naturelle, pas une liste. `written` alimente la passe de nettoyage, qui n'a
 * pas cette limite et a besoin des graphies exactes (`vite.config.ts`, `@scope/pkg`).
 */
export interface Lexicon {
  spoken: string
  written: string[]
}

/** Ce qui décrit un projet sans avoir à fouiller son code. */
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

/**
 * En mémoire seulement : la génération est rapide et peu coûteuse, un redémarrage du
 * serveur la refait au premier usage. Un échec est retenu aussi, sinon chaque dictée
 * repartirait taper un fournisseur qui vient de refuser.
 */
const cache = new Map<string, CachedLexicon>()

export type ChatCall = (system: string, user: string) => Promise<string>

/**
 * Lexique du projet, régénéré quand ses sources changent.
 *
 * `null` quand le workspace ne décrit rien ou que la génération a échoué : la dictée
 * fonctionne alors sans biais, ce qui reste mieux que de la bloquer.
 */
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

/**
 * Lecture indulgente : tous les fournisseurs ne savent pas forcer du JSON, et un
 * modèle bavard enrobe parfois sa réponse. On extrait le premier objet plausible.
 */
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
