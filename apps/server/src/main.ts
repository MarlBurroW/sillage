import { mkdirSync } from 'node:fs'
import { openDatabase } from '@sillage/db'
import { createAgentRegistry } from './agents/registry.js'
import { purgeExpiredSessions } from './auth/sessions.js'
import { loadConfig } from './config.js'
import { AttachmentStore } from './attachments/store.js'
import { EventLog } from './events/event-log.js'
import { buildApp } from './http/app.js'
import { migrationsFolder, runPendingMigrations } from './migrations.js'
import { PushService } from './push/push-service.js'
import { SecretStore, loadOrCreateKey } from './secrets/store.js'
import { SessionManager } from './sessions/session-manager.js'
import { TerminalManager } from './terminals/terminal-manager.js'

async function main(): Promise<void> {
  const config = loadConfig()
  for (const dir of [config.paths.attachments, config.paths.worktrees, config.paths.logs]) {
    mkdirSync(dir, { recursive: true })
  }

  const { db, sqlite } = openDatabase(config.paths.database)
  runPendingMigrations(db, migrationsFolder())
  await purgeExpiredSessions(db)

  const log = new EventLog(db)
  // Partagé entre le gestionnaire de sessions et les routes : les adaptateurs portent
  // les caches de catalogue et de quota, qui ne doivent exister qu'une fois.
  const registry = createAgentRegistry(config)
  // La clé vit à côté de la base, pas dedans : c'est ce qui fait qu'une base copiée
  // seule ne livre pas les secrets qu'elle contient.
  const secrets = new SecretStore(db, loadOrCreateKey(config.paths.data))
  const sessions = new SessionManager(db, log, config, registry, secrets)
  const attachments = new AttachmentStore(db, config.paths.attachments)
  const terminals = new TerminalManager(config)
  const recovered = sessions.recoverInterrupted()

  // Les fichiers téléversés puis jamais envoyés s'accumuleraient sinon sans limite.
  const orphans = await attachments.purgeOrphans()

  const push = new PushService(db, config.paths.data)
  const app = await buildApp(
    { db, config },
    log,
    sessions,
    registry,
    attachments,
    terminals,
    push,
    secrets,
  )
  push.setLogger(app.log)
  if (orphans > 0) app.log.info({ orphans }, 'pieces jointes orphelines supprimees')
  if (recovered > 0) {
    app.log.info({ recovered }, 'conversations marquees interrompues apres redemarrage')
  }
  await app.listen({ host: config.server.host, port: config.server.port })

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'arrêt en cours')
    await sessions.stopAll()
    terminals.closeAll()
    await app.close()
    sqlite.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
