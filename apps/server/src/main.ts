import { mkdirSync } from 'node:fs'
import { openDatabase, projects } from '@sillage/db'
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
import { announceToLauncher, openDesktopSession, scrubLauncherEnv } from './instance/desktop.js'
import { INSTANCE_PROFILE } from './instance/profile.js'
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
import { installCredentialLauncher } from './git-credential/helper.js'
import { upgradeCredentialHelpers } from './git-credential/migrate.js'
import { ClaudeAccountStore } from './claude-accounts/store.js'
import { ClaudeLoginService } from './claude-accounts/login.js'
import { ClaudeAccountGauges } from './claude-accounts/gauges.js'
import { CodexAccountHomes } from './codex-accounts/homes.js'
import { CodexLoginService } from './codex-accounts/login.js'
import { CodexAccountStore } from './codex-accounts/store.js'
import { GrokAccountHomes } from './grok-accounts/homes.js'
import { AntigravityAccountHomes } from './antigravity-accounts/homes.js'
import { GrokLoginService } from './grok-accounts/login.js'
import { AntigravityLoginService } from './antigravity-accounts/login.js'
import { GrokAccountStore } from './grok-accounts/store.js'
import { AntigravityAccountStore } from './antigravity-accounts/store.js'
import { loadOrCreateKey } from './secrets/cipher.js'
import { SecretStore } from './secrets/store.js'
import { SessionManager } from './sessions/session-manager.js'
import { TerminalManager } from './terminals/terminal-manager.js'
import { backfillCommandPaths } from './worktrees/backfill.js'
import { WorktreeCleanup } from './worktrees/cleanup.js'
import { watchMergedCards } from './worktrees/merged-cards.js'
import { WorktreeStatusService } from './worktrees/status-service.js'

async function main(): Promise<void> {
  const config = loadConfig()
  if (INSTANCE_PROFILE === 'desktop') scrubLauncherEnv()
  for (const dir of [config.paths.attachments, config.paths.worktrees, config.paths.logs]) {
    mkdirSync(dir, { recursive: true })
  }

  const { db, sqlite } = openDatabase(config.paths.database)
  runPendingMigrations(db, migrationsFolder())
  backfillCommandPaths(db)
  await purgeExpiredSessions(db)
  purgeIdempotencyKeys(db)

  const log = new EventLog(db)
  // Shared by session managers and routes: adapters own catalog and quota caches,
  // which must exist only once.
  const registry = createAgentRegistry(config)
  // Keys live beside databases rather than inside them, so copying databases alone
  // does not reveal their secrets.
  const encryptionKey = loadOrCreateKey(config.paths.data)
  const secrets = new SecretStore(db, encryptionKey)
  const gitCredentials = new GitCredentialStore(db, encryptionKey)
  const claudeGauges = new ClaudeAccountGauges(config.paths.claudeAccounts)
  const claudeAccounts = new ClaudeAccountStore(db, encryptionKey, claudeGauges)
  // Guided login drives the CLI resolved identically to conversations.
  const claudeLogin = new ClaudeLoginService(claudeAccounts, () => registry.adapter('claude').cli.executable(), claudeGauges)
  const codexAccounts = { store: new CodexAccountStore(db), homes: new CodexAccountHomes(config.paths.codexAccounts) }
  // Codex account login starts the CLI app-server using conversation resolution:
  // Sillage-managed binaries take precedence over PATH binaries.
  const codexLogin = new CodexLoginService(codexAccounts.homes, codexAccounts.store, () => registry.adapter('codex').cli.executable())
  const grokAccounts = { store: new GrokAccountStore(db), homes: new GrokAccountHomes(config.paths.grokAccounts) }
  const antigravityStore = new AntigravityAccountStore(db)
  const antigravityAccounts = { store: antigravityStore, homes: new AntigravityAccountHomes(config.paths.antigravityAccounts, (id) => antigravityStore.ownerOf(id)) }
  const grokLogin = new GrokLoginService(grokAccounts.homes, grokAccounts.store, () => registry.adapter('grok').cli.executable())
  const sessions = new SessionManager(db, log, config, registry, secrets, claudeAccounts, codexAccounts, grokAccounts, antigravityAccounts)
  const antigravityLogin = new AntigravityLoginService(antigravityAccounts.homes, antigravityAccounts.store, () => registry.adapter('antigravity').cli.executable(), (id) => sessions.stopAntigravityAccount(id))
  const attachments = new AttachmentStore(db, config.paths.attachments)
  const terminals = new TerminalManager(config)
  // Project buttons execute commands in terminals or systemd units.
  const actions = new ActionRunner(db, config, terminals)
  const recovered = sessions.recoverInterrupted()
  const webhooks = new WebhookService(db, log, sessions, config.server.publicUrl)
  // Construct before the application whose routes deliver or dismiss held messages,
  // but start afterward because the logger does not exist earlier.
  const relay = new SessionRelay(db, sessions, log)
  const push = new PushService(db, config.paths.data, config.server.publicUrl)
  // Toast on visible-app devices; system notifications elsewhere.
  const notifications = new Notifications(db, push)
  // Human decisions requested by autonomous sessions without blocking.
  // Project worktree progress invalidated at every turn completion.
  const worktreeStatus = new WorktreeStatusService(db, log)
  const decisions = new DecisionService({ db, config }, sessions, notifications)
  // Cleaning work closes terminals and archives sessions; detected merges
  // propose cleanup in 'To decide'.
  const worktreeCleanup = new WorktreeCleanup(db, config.paths.data, worktreeStatus, terminals, (id) => sessions.dropCheckpoints(id))
  watchMergedCards(db, worktreeStatus)
  // GitHub issue-linked board reads repositories, publishes local changes,
  // and opens maintenance sessions triggered by issues or comments.
  const board = new BoardSync({ db, config }, gitCredentials, fetch, new BoardResponder({ db, config }, sessions, registry))
  // Session launches and cards requested by agents through MCP.
  const agentRequests = new AgentRequests({ db, config }, sessions, registry, actions, encryptionKey, board, decisions, log, worktreeStatus, attachments, terminals)
  // User- or agent-scheduled tasks executed in fresh sessions.
  const tasks = new TaskScheduler({ db, config }, sessions, registry, log)

  // Otherwise uploads never sent would accumulate indefinitely.
  const orphans = await attachments.purgeOrphans()

  // Automation webhooks decide whether to run; the scheduler executes.
  const automations = new AutomationReceiver({ db, config }, encryptionKey, tasks, push)
  // Construct before the application exposing its rescheduling route,
  // but start after the logger exists.
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
    grokAccounts,
    antigravityAccounts,
    grokLogin,
    antigravityLogin,
    webhooks,
    scheduler,
    relay,
    tasks,
    actions,
    automations,
    board,
    notifications,
    decisions,
    worktreeStatus,
    worktreeCleanup,
  )
  push.setLogger(app.log)
  automations.setLogger(app.log)
  if (orphans > 0) app.log.info({ orphans }, 'pieces jointes orphelines supprimees')
  if (recovered.length > 0) {
    app.log.info({ recovered: recovered.length }, 'conversations marquees interrompues apres redemarrage')
  }
  // After buildApp for logging, before listen to miss nothing:
  // every API task killed by restart must notify its caller.
  webhooks.start()
  webhooks.sessionEnded(recovered)

  registerMaintenanceJobs(scheduler, { db, attachments, log: app.log, config })
  scheduler.start(app.log)
  // After `recoverInterrupted`: statuses choosing steering versus restart
  // must describe this process's runners rather than the previous process's.
  relay.start(app.log)
  agentRequests.start(app.log)
  // Also after `recoverInterrupted`: restart-interrupted runs must show
  // 'interrupted' instead of 'running' until their maximum duration.
  tasks.start(app.log)
  board.start(app.log)
  decisions.start(app.log)

  await app.listen({ host: config.server.host, port: config.server.port })

  // Desktop waits for this announcement before opening windows: servers already
  // respond and user sessions are ready for cookies.
  if (INSTANCE_PROFILE === 'desktop') {
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : config.server.port
    announceToLauncher(port, await openDesktopSession(db))
  }

  // Git helper launchers describe this process's Node and release. Rewrite every
  // startup to follow upgrades without changing cloned repositories.
  // Then migrate older clones to launchers. After listen, without awaiting:
  // one git process per project must not delay server opening.
  try {
    installCredentialLauncher(config.paths)
    const workspaces = db.select({ path: projects.workspacePath }).from(projects).all().map((row) => row.path)
    upgradeCredentialHelpers(workspaces, config.paths)
      .then((upgraded) => {
        if (upgraded.length > 0) app.log.info({ repos: upgraded }, 'helper git des depots clones mis a jour')
      })
      .catch((err: unknown) => app.log.warn({ err }, 'mise a jour du helper git des depots impossible'))
  } catch (err) {
    // Incomplete installations without `.mjs` still serve without helpers.
    app.log.warn({ err }, 'lanceur du helper git non installe')
  }

  // Shutdown requests may overlap (signals followed by desktop closing stdin):
  // the second must not close resources already closed by the first.
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    app.log.info({ signal }, 'arrêt en cours')
    // Before stopAll expires requests: statuses still identify in-flight work,
    // and persisted deliveries will send at next startup.
    webhooks.shutdownFlush()
    webhooks.stop()
    scheduler.stop()
    relay.stop()
    agentRequests.stop()
    tasks.stop()
    board.stop()
    decisions.stop()
    await antigravityLogin.closeAll()
    await sessions.stopAll()
    terminals.shutdown()
    await app.close()
    sqlite.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // Desktop requests shutdown by closing stdin: Windows has no appropriate signal,
  // and killing servers would orphan session CLIs.
  // Stdin also closes on unexpected app death, taking the server with it.
  if (INSTANCE_PROFILE === 'desktop') {
    process.stdin.on('end', () => void shutdown('launcher'))
    process.stdin.resume()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
