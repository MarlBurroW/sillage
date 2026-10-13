import { mkdirSync } from 'node:fs'
import { openDatabase } from '@sillage/db'
import { createAgentRegistry } from './agents/registry.js'
import { purgeIdempotencyKeys } from './auth/api-tokens.js'
import { WebhookService } from './webhooks/service.js'
import { purgeExpiredSessions } from './auth/sessions.js'
import { loadConfig } from './config.js'
import { AttachmentStore } from './attachments/store.js'
import { ActionRunner } from './actions/actions.js'
import { AutomationReceiver } from './automations/receiver.js'
import { BoardSync } from './board/board-sync.js'
import { BoardResponder } from './board/responder.js'
import { EventLog } from './events/event-log.js'
import { buildApp } from './http/app.js'
import { migrationsFolder, runPendingMigrations } from './migrations.js'
import { PushService } from './push/push-service.js'
import { Notifications } from './notifications/dispatcher.js'
import { DecisionService } from './decisions/service.js'
import { registerMaintenanceJobs } from './scheduler/jobs.js'
import { Scheduler } from './scheduler/scheduler.js'
import { TaskScheduler } from './scheduler/task-scheduler.js'
import { AgentRequests } from './sessions/agent-requests.js'
import { SessionRelay } from './sessions/session-relay.js'
import { GitCredentialStore } from './git-credentials/store.js'
import { ClaudeAccountStore } from './claude-accounts/store.js'
import { ClaudeLoginService } from './claude-accounts/login.js'
import { ClaudeAccountGauges } from './claude-accounts/gauges.js'
import { CodexAccountHomes } from './codex-accounts/homes.js'
import { CodexLoginService } from './codex-accounts/login.js'
import { CodexAccountStore } from './codex-accounts/store.js'
import { loadOrCreateKey } from './secrets/cipher.js'
import { SecretStore } from './secrets/store.js'
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
  purgeIdempotencyKeys(db)

  const log = new EventLog(db)
  // Partagé entre le gestionnaire de sessions et les routes : les adaptateurs portent
  // les caches de catalogue et de quota, qui ne doivent exister qu'une fois.
  const registry = createAgentRegistry(config)
  // La clé vit à côté de la base, pas dedans : c'est ce qui fait qu'une base copiée
  // seule ne livre pas les secrets qu'elle contient.
  const encryptionKey = loadOrCreateKey(config.paths.data)
  const secrets = new SecretStore(db, encryptionKey)
  const gitCredentials = new GitCredentialStore(db, encryptionKey)
  const claudeGauges = new ClaudeAccountGauges(config.paths.claudeAccounts)
  const claudeAccounts = new ClaudeAccountStore(db, encryptionKey, claudeGauges)
  // La connexion guidée pilote le CLI, résolu comme pour les conversations.
  const claudeLogin = new ClaudeLoginService(claudeAccounts, () => registry.adapter('claude').cli.executable(), claudeGauges)
  const codexAccounts = { store: new CodexAccountStore(db), homes: new CodexAccountHomes(config.paths.codexAccounts) }
  // La connexion d'un compte Codex lance l'app-server du CLI, résolu comme pour les
  // conversations : le binaire que Sillage gère passe avant celui du PATH.
  const codexLogin = new CodexLoginService(codexAccounts.homes, codexAccounts.store, () => registry.adapter('codex').cli.executable())
  const sessions = new SessionManager(db, log, config, registry, secrets, claudeAccounts, codexAccounts)
  const attachments = new AttachmentStore(db, config.paths.attachments)
  const terminals = new TerminalManager(config)
  // Boutons des projets : commandes jouées dans un terminal ou une unité systemd.
  const actions = new ActionRunner(db, config, terminals)
  const recovered = sessions.recoverInterrupted()
  const webhooks = new WebhookService(db, log, sessions, config.server.publicUrl)
  // Construit avant l'application, dont les routes remettent ou écartent un message
  // retenu, mais démarré après elle, faute de logger avant.
  const relay = new SessionRelay(db, sessions, log)
  const push = new PushService(db, config.paths.data, config.server.publicUrl)
  // Toast sur l'appareil où l'application est visible, notification système ailleurs.
  const notifications = new Notifications(db, push)
  // Ce que demandent les sessions autonomes à un humain, sans se bloquer.
  const decisions = new DecisionService({ db, config }, sessions, notifications)
  // Board relié aux issues GitHub : lit le dépôt, renvoie les changements faits ici, et
  // ouvre les sessions de maintenance qu'une issue ou un commentaire déclenche.
  const board = new BoardSync({ db, config }, gitCredentials, fetch, new BoardResponder({ db, config }, sessions, registry))
  // Lancements de sessions et cartes demandés par les agents, par le serveur MCP.
  const agentRequests = new AgentRequests({ db, config }, sessions, registry, actions, encryptionKey, board, decisions)
  // Tâches planifiées par l'utilisateur ou par un agent, tirées dans des sessions neuves.
  const tasks = new TaskScheduler({ db, config }, sessions, registry, log)

  // Les fichiers téléversés puis jamais envoyés s'accumuleraient sinon sans limite.
  const orphans = await attachments.purgeOrphans()

  // Appels des webhooks d'automatisation : il décide, le planificateur tire.
  const automations = new AutomationReceiver({ db, config }, encryptionKey, tasks, push)
  // Construit avant l'application, qui expose la route capable de le reprogrammer, mais
  // démarré après elle, faute de logger avant.
  const scheduler = new Scheduler()
  const app = await buildApp(
    { db, config },
    log,
    sessions,
    registry,
    attachments,
    terminals,
    push,
    secrets,
    gitCredentials,
    claudeAccounts,
    claudeLogin,
    codexAccounts,
    codexLogin,
    webhooks,
    scheduler,
    relay,
    tasks,
    actions,
    automations,
    board,
    notifications,
    decisions,
  )
  push.setLogger(app.log)
  automations.setLogger(app.log)
  if (orphans > 0) app.log.info({ orphans }, 'pieces jointes orphelines supprimees')
  if (recovered.length > 0) {
    app.log.info({ recovered: recovered.length }, 'conversations marquees interrompues apres redemarrage')
  }
  // Après buildApp pour que le logger existe, avant listen pour ne rien manquer :
  // chaque tâche d'API tuée par le redémarrage doit le dire à son appelant.
  webhooks.start()
  webhooks.sessionEnded(recovered)

  registerMaintenanceJobs(scheduler, { db, attachments, log: app.log, config })
  scheduler.start(app.log)
  // Après `recoverInterrupted` : les statuts lus pour choisir entre inflexion et relance
  // doivent décrire les runners de ce process, pas ceux du précédent.
  relay.start(app.log)
  agentRequests.start(app.log)
  // Après `recoverInterrupted` aussi : un tir coupé par le redémarrage doit se lire
  // « interrompu », pas « en cours » jusqu'à sa durée maximale.
  tasks.start(app.log)
  board.start(app.log)
  decisions.start(app.log)

  await app.listen({ host: config.server.host, port: config.server.port })

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'arrêt en cours')
    // Avant stopAll, qui expire les sollicitations : les statuts disent encore ce qui
    // était en vol, et les livraisons persistées partiront au prochain démarrage.
    webhooks.shutdownFlush()
    webhooks.stop()
    scheduler.stop()
    relay.stop()
    agentRequests.stop()
    tasks.stop()
    board.stop()
    decisions.stop()
    await sessions.stopAll()
    terminals.shutdown()
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
