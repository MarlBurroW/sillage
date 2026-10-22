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
import { requireAdmin, requireUser } from '../require-user.js'

/** Voice dictation sends browser audio to the configured OpenAI-compatible provider and returns composer-ready text. Two optional stages improve on raw Whisper: the transcription `prompt` receives the project lexicon (`stt/lexicon.ts`) and current branch to avoid phonetic corruption of proper names; a configured chat model then restores exact spellings and removes hesitations. Failures in either stage are silent because raw dictation is preferable to an error. */
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

    const { provider, cleanupModel } = resolveProvider(ctx, secrets)
    const chat: ChatCall | null = cleanupModel
      ? (system, prompt) => complete({ ...provider, model: cleanupModel }, system, prompt)
      : null

    const workspace = workspaceOf(ctx, textField(file.fields, 'projectId'), user.id)
    const branch = workspace ? await currentBranch(workspace) : null
    const lexicon =
      workspace && chat
        ? await projectLexicon(workspace.projectId, workspace.path, chat)
        : null

    const language = textField(file.fields, 'language')
    const raw = await transcribe(
      provider,
      { content, filename: file.filename || 'dictation.webm', mimeType: file.mimetype },
      {
        prompt: spokenBias(lexicon, branch),
        // Two letters or nothing: client input is forwarded to the provider.
        language: language && /^[a-z]{2}$/.test(language) ? language : undefined,
      },
    )

    const trimmed = raw.trim()
    if (!chat || trimmed.length === 0) return { text: trimmed }

    const cleaned = await cleanup(chat, trimmed, lexicon, branch).catch(() => null)
    return { text: cleaned ?? trimmed }
  })

  /** Settings-screen configuration check: follows a real dictation path with a short browser-generated sample, plus a cleanup model call that silent audio transcription would not exercise. Failures return translated errors, as dictation does. */
  app.post('/api/stt/test', async (request): Promise<{ cleanupTested: boolean }> => {
    requireAdmin(request)

    const file = await request.file()
    const content = file ? await file.toBuffer().catch(() => null) : null
    if (!file || !content || content.byteLength === 0) {
      throw badRequest('no_audio', 'No audio received.')
    }

    const { provider, cleanupModel } = resolveProvider(ctx, secrets)
    await transcribe(
      provider,
      { content, filename: file.filename || 'test.webm', mimeType: file.mimetype },
      {},
    )
    if (cleanupModel) {
      await complete(
        { ...provider, model: cleanupModel },
        'You are a connectivity check.',
        'Reply with the single word OK.',
      )
    }
    return { cleanupTested: Boolean(cleanupModel) }
  })
}

/** Resolves settings into a ready-to-call client, including appropriate rejections. */
function resolveProvider(
  ctx: AppContext,
  secrets: SecretStore,
): { provider: SttProvider; cleanupModel: string } {
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
  return {
    provider: {
      baseUrl: settings.sttBaseUrl.replace(/\/+$/, ''),
      model: settings.sttModel,
      apiKey,
    },
    cleanupModel: settings.sttCleanupModel,
  }
}

function textField(fields: Record<string, Multipart | Multipart[] | undefined>, name: string): string | null {
  const field = fields[name]
  const single = Array.isArray(field) ? field[0] : field
  if (!single || single.type !== 'field' || typeof single.value !== 'string') return null
  return single.value || null
}

/** The same visibility rule as elsewhere: inaccessible projects are 'not found'. */
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

/** Read `.git/HEAD` directly instead of spawning git on the dictation path. Unreadable branches (missing repository, detached HEAD, worktree) yield null. */
async function currentBranch(workspace: { path: string }): Promise<string | null> {
  const head = await readFile(join(workspace.path, '.git', 'HEAD'), 'utf8').catch(() => null)
  const match = head ? /^ref: refs\/heads\/(.+)$/m.exec(head.trim()) : null
  return match?.[1] ?? null
}

/** Whisper bias: spoken lexicon plus the current branch. */
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
  // An empty or oversized response indicates the model did something other than
  // correction: fall back to raw transcription.
  if (cleaned.length === 0 || cleaned.length > transcript.length * 3 + 200) return null
  return cleaned
}
