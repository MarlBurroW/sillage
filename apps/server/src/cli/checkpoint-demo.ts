import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase } from '@sillage/db'
import { captureSnapshot, checkpointRef, diffCheckpoint } from '../checkpoints.js'
import { loadConfig } from '../config.js'
import { EventLog } from '../events/event-log.js'
import { resolveConversationCwd } from '../workspace.js'

/**
 * Joue un tour capturé sur la conversation de démo « Add offline caching for forecasts »,
 * sans agent : les deux captures sont réelles, les fichiers sont réellement changés
 * dans le worktree, et le journal reçoit la même suite d'événements qu'un vrai tour.
 *
 * Sert à `scripts/checkpoints-ui-check.mjs`, qui vérifie l'interface sur un serveur
 * jetable : le passage Playwright n'a pas à attendre un vrai CLI pour voir le repère
 * de fin de tour, l'onglet Git filtré et la restauration.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  if (config.paths.data === join(process.env.HOME ?? '', '.local/share/sillage')) {
    throw new Error('Refusing to touch the default data dir. Point SILLAGE_DATA_DIR at a demo dir.')
  }
  const { db, sqlite } = openDatabase(config.paths.database)
  const log = new EventLog(db)

  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.title, 'Add offline caching for forecasts'))
    .get()
  if (!conversation) throw new Error('Demo conversation not found: run demo-seed first.')
  const cwd = resolveConversationCwd(db, conversation)

  const key = randomUUID()
  await captureSnapshot(cwd, checkpointRef(conversation.id, key, 'before'))
  log.append(conversation.id, { type: 'checkpoint.started', key })
  const messageId = `msg_${randomUUID()}`
  log.append(conversation.id, {
    type: 'message.completed',
    messageId,
    role: 'user',
    blocks: [{ type: 'text', text: 'Add a CHANGELOG entry and drop the stale fixture.' }],
    parentToolCallId: null,
  })
  log.append(conversation.id, { type: 'turn.started' })

  // Le travail du tour : un fichier créé, un modifié, un supprimé.
  const edits: { path: string; action: 'created' | 'modified' | 'deleted'; content: string | null }[] = [
    { path: 'CHANGELOG.md', action: 'created', content: '# Changelog\n\n- Cache forecasts offline.\n' },
    { path: 'README.md', action: 'modified', content: '# Nimbus\n\nWeather, now with an offline cache.\n' },
    { path: 'src/lib/forecast.ts', action: 'deleted', content: null },
  ]
  for (const edit of edits) {
    const toolCallId = `toolu_${randomUUID().slice(0, 8)}`
    log.append(conversation.id, {
      type: 'tool.started',
      toolCallId,
      name: edit.action === 'deleted' ? 'Bash' : 'Write',
      input: edit.action === 'deleted' ? { command: `rm ${edit.path}` } : { file_path: edit.path, content: edit.content },
      parentToolCallId: null,
    })
    if (edit.content === null) rmSync(join(cwd, edit.path), { force: true })
    else {
      mkdirSync(dirname(join(cwd, edit.path)), { recursive: true })
      writeFileSync(join(cwd, edit.path), edit.content)
    }
    log.append(conversation.id, { type: 'file.edited', toolCallId, path: edit.path, action: edit.action })
    log.append(conversation.id, {
      type: 'tool.completed',
      toolCallId,
      output: edit.action === 'deleted' ? '' : `Wrote ${edit.path}`,
      isError: false,
      durationMs: 120,
    })
  }
  log.append(conversation.id, {
    type: 'message.completed',
    messageId: `msg_${randomUUID()}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Done: changelog added, README updated, stale fixture removed.' }],
    parentToolCallId: null,
  })
  log.append(conversation.id, {
    type: 'turn.completed',
    stopReason: 'end_turn',
    costUsd: 0.01,
    inputTokens: 10,
    outputTokens: 60,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  })

  await captureSnapshot(cwd, checkpointRef(conversation.id, key, 'after'))
  const diff = await diffCheckpoint(cwd, conversation.id, key, edits.map((edit) => edit.path))
  log.append(conversation.id, {
    type: 'checkpoint.completed',
    key,
    status: 'ready',
    reason: null,
    files: diff.files,
    truncated: false,
    excluded: diff.excluded,
  })
  log.refreshTurnCount(conversation.id)
  sqlite.close()
  console.log(JSON.stringify({ conversationId: conversation.id, cwd, key, files: diff.files.length }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
