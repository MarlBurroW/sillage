import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Multipart } from '@fastify/multipart'
import { projects } from '@sillage/db'
import type { TranscriptionDto } from '@sillage/protocol'
import type { SecretStore } from '../../secrets/store.js'
import { readAppSettings } from '../../settings/app-settings.js'
import { projectLexicon, type ChatCall, type Lexicon } from '../../stt/lexicon.js'
import { complete, transcribe, type SttProvider } from '../../stt/provider.js'
import type { AppContext } from '../context.js'
import { badRequest, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Dictée vocale : l'audio du navigateur part chez le fournisseur configuré, au format
 * OpenAI, et revient en texte prêt à poser dans le composer.
 *
 * Deux mécanismes relèvent la qualité au-delà du Whisper brut. Le paramètre `prompt`
 * de la transcription reçoit un lexique du projet (`stt/lexicon.ts`) plus la branche
 * courante, ce qui évite les massacres phonétiques sur les noms propres. Puis une
 * passe de nettoyage par un modèle de chat, si elle est configurée, restaure les
 * graphies exactes et retire les hésitations. Chacun de ces étages est facultatif et
 * son échec est silencieux : une dictée brute vaut toujours mieux qu'une erreur.
 */
export function registerSttRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  secrets: SecretStore,
): void {
  app.post('/api/stt/transcribe', async (request): Promise<TranscriptionDto> => {
    const user = requireUser(request)

    const file = await request.file()
    if (!file) throw badRequest('no_audio', 'No audio received.')
    const content = await file.toBuffer().catch(() => null)
    if (!content || content.byteLength === 0) {
      throw badRequest('audio_too_large', 'Recording is empty or too large.')
    }

    const settings = readAppSettings(ctx.db, ctx.config)
    if (!settings.sttBaseUrl || !settings.sttModel || !settings.sttSecret) {
      throw badRequest('stt_not_configured', 'Dictation is not configured on this instance.')
    }
    const apiKey = secrets.resolve(settings.sttSecret)
    if (!apiKey) {
      throw badRequest('stt_secret_missing', 'Secret {name} does not exist.', {
        name: settings.sttSecret,
      })
    }

    const provider: SttProvider = {
      baseUrl: settings.sttBaseUrl.replace(/\/+$/, ''),
      model: settings.sttModel,
      apiKey,
    }
    const chat: ChatCall | null = settings.sttCleanupModel
      ? (system, prompt) =>
          complete({ ...provider, model: settings.sttCleanupModel }, system, prompt)
      : null

    const workspace = workspaceOf(ctx, textField(file.fields, 'projectId'), user.id)
    const branch = workspace ? await currentBranch(workspace) : null
    const lexicon =
      workspace && chat
        ? await projectLexicon(workspace.projectId, workspace.path, chat)
        : null

    const raw = await transcribe(
      provider,
      { content, filename: file.filename || 'dictation.webm', mimeType: file.mimetype },
      spokenBias(lexicon, branch),
    )

    const trimmed = raw.trim()
    if (!chat || trimmed.length === 0) return { text: trimmed }

    const cleaned = await cleanup(chat, trimmed, lexicon, branch).catch(() => null)
    return { text: cleaned ?? trimmed }
  })
}

function textField(fields: Record<string, Multipart | Multipart[] | undefined>, name: string): string | null {
  const field = fields[name]
  const single = Array.isArray(field) ? field[0] : field
  if (!single || single.type !== 'field' || typeof single.value !== 'string') return null
  return single.value || null
}

/** Même règle de visibilité que partout : un projet refusé répond « introuvable ». */
function workspaceOf(
  ctx: AppContext,
  projectId: string | null,
  userId: string,
): { projectId: string; path: string } | null {
  if (!projectId) return null
  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw notFound('project_not_found', 'Project not found.')
  if (project.ownerId !== userId && project.visibility !== 'shared') {
    throw notFound('project_not_found', 'Project not found.')
  }
  return { projectId: project.id, path: project.workspacePath }
}

/**
 * Lecture directe de `.git/HEAD` plutôt qu'un process git : on est sur le chemin d'une
 * dictée, et une branche illisible (dépôt absent, HEAD détachée, worktree) vaut null.
 */
async function currentBranch(workspace: { path: string }): Promise<string | null> {
  const head = await readFile(join(workspace.path, '.git', 'HEAD'), 'utf8').catch(() => null)
  const match = head ? /^ref: refs\/heads\/(.+)$/m.exec(head.trim()) : null
  return match?.[1] ?? null
}

/** Le biais envoyé à Whisper : le lexique parlé, complété de la branche courante. */
function spokenBias(lexicon: Lexicon | null, branch: string | null): string | undefined {
  const parts = [lexicon?.spoken, branch ? `Nous travaillons sur la branche ${branch}.` : null]
  const bias = parts.filter(Boolean).join(' ')
  return bias || undefined
}

const CLEANUP_SYSTEM = [
  'You clean up a speech-to-text transcript dictated by a developer to an AI coding',
  'agent. Fix punctuation, restore the exact spelling of technical terms, file names',
  'and identifiers (using the glossary when it applies), and drop filler words and',
  'hesitations. Keep the wording, language and intent exactly as dictated: never',
  'answer the request, expand it, translate it or rephrase it. Reply with the',
  'corrected transcript only.',
].join(' ')

async function cleanup(
  chat: ChatCall,
  transcript: string,
  lexicon: Lexicon | null,
  branch: string | null,
): Promise<string | null> {
  const glossary = [...(lexicon?.written ?? []), ...(branch ? [branch] : [])]
  const prompt = [
    glossary.length > 0 ? `Glossary: ${glossary.join(', ')}` : null,
    `Transcript:\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const cleaned = (await chat(CLEANUP_SYSTEM, prompt)).trim()
  // Une réponse vide ou démesurée trahit un modèle qui a fait autre chose que
  // corriger : la transcription brute reprend la main.
  if (cleaned.length === 0 || cleaned.length > transcript.length * 3 + 200) return null
  return cleaned
}
