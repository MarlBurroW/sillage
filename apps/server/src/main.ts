import { PreviewService } from './previews/service.js'
import { BrowserManager } from './browser/manager.js'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { removeMaterializedSystemSkills } from './agents/antigravity/system-skills.js'
import { openDatabase, projects } from '@sillage/db'
import { createAgentRegistry } from './agents/registry.js'
import { installFaultPolicy } from './detach.js'
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
import { acquireInstanceLock } from './instance/lock.js'
import { CURRENT_VERSION } from './update/version.js'
import { migrationsFolder, runPendingMigrations } from './migrations.js'
import { PushService } from './push/push-service.js'
import { Notifications } from './notifications/dispatcher.js'
import { DecisionService } from './decisions/service.js'
import { UsageLimitResumeService } from './usage-limits/resume-service.js'
import { registerMaintenanceJobs } from './scheduler/jobs.js'
import { Scheduler } from './scheduler/scheduler.js'
import { TaskScheduler } from './scheduler/task-scheduler.js'
import { BenchmarkRunner } from './benchmarks/runner.js'
import { TurnUsageRecorder } from './consumption/recorder.js'
import { PriceCatalog } from './pricing/catalog.js'
import { AgentRequests } from './sessions/agent-requests.js'
import { SessionRelay } from './sessions/session-relay.js'
import { GitCredentialStore } from './git-credentials/store.js'
import { installCredentialLauncher } from './git-credential/helper.js'
import { upgradeCredentialHelpers } from './git-credential/migrate.js'
import { ClaudeAccountStore } from './claude-accounts/store.js'
import { ClaudeLoginService } from './claude-accounts/login.js'
import { CodexAccountHomes } from './codex-accounts/homes.js'
import { CodexLoginService } from './codex-accounts/login.js'
import { CodexAccountStore } from './codex-accounts/store.js'
import { GrokAccountHomes } from './grok-accounts/homes.js'
import { AntigravityAccountHomes, userAntigravityHome } from './antigravity-accounts/homes.js'
import { GrokLoginService } from './grok-accounts/login.js'
import { AntigravityLoginService } from './antigravity-accounts/login.js'
import { GrokAccountStore } from './grok-accounts/store.js'
import { AntigravityAccountStore } from './antigravity-accounts/store.js'
import { CopilotAccountHomes } from './copilot-accounts/homes.js'
import { CopilotLoginService } from './copilot-accounts/login.js'
import { CopilotAccountStore } from './copilot-accounts/store.js'
import { loadOrCreateKey } from './secrets/cipher.js'
import { SecretStore } from './secrets/store.js'
import { SessionManager } from './sessions/session-manager.js'
import { TerminalManager } from './terminals/terminal-manager.js'
import { backfillCommandPaths } from './worktrees/backfill.js'
import { WorktreeCleanup } from './worktrees/cleanup.js'
import { watchMergedCards } from './worktrees/merged-cards.js'
import { WorktreeStatusService } from './worktrees/status-service.js'
import { WorktreeRemoteStatus } from './worktrees/remote-status.js'
import { detach } from './detach.js'
import { conversationMediaRoot } from './conversations/media.js'

/** Below the Desktop launcher's 15 s grace and systemd's TimeoutStopSec, so the process ends on its own terms. */
const SHUTDOWN_DEADLINE_MS = 12_000

async function main(): Promise<void> {
  // Installed first so a rejection during boot is logged too. Until the services exist, a fatal
  // error has nothing to stop: the process just exits.
  let stopForFault: (() => Promise<void>) | null = null
  installFaultPolicy({ onFatal: () => stopForFault?.() ?? Promise.resolve() })

  const config = loadConfig()
  if (INSTANCE_PROFILE === 'desktop') scrubLauncherEnv()
  for (const dir of [config.paths.attachments, conversationMediaRoot(config.paths.data), config.paths.worktrees, config.paths.logs]) {
    mkdirSync(dir, { recursive: true })
  }

  // Before anything touches the database: migrations, purges and restart recovery all rewrite
  // state a running daemon owns. Held for the life of the process.
  const lock = await acquireInstanceLock(config.paths.database, { role: 'daemon', version: CURRENT_VERSION })
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
  // Second Claude logins once kept here for usage gauges are unused now that the account
  // token reads usage itself: remove their credentials rather than leave refresh tokens behind.
  rmSync(config.paths.claudeAccounts, { recursive: true, force: true })
  const claudeAccounts = new ClaudeAccountStore(db, encryptionKey)
  // Guided login drives the CLI resolved identically to conversations.
  const claudeLogin = new ClaudeLoginService(claudeAccounts, () => registry.adapter('claude').cli.executable())
  const codexAccounts = { store: new CodexAccountStore(db), homes: new CodexAccountHomes(config.paths.codexAccounts) }
  // Codex account login starts the CLI app-server using conversation resolution:
  // Sillage-managed binaries take precedence over PATH binaries.
  const codexLogin = new CodexLoginService(codexAccounts.homes, codexAccounts.store, () => registry.adapter('codex').cli.executable())
  const grokAccounts = { store: new GrokAccountStore(db), homes: new GrokAccountHomes(config.paths.grokAccounts) }
  const antigravityStore = new AntigravityAccountStore(db)
  const antigravityAccounts = { store: antigravityStore, homes: new AntigravityAccountHomes(config.paths.antigravityAccounts, (id) => antigravityStore.ownerOf(id)) }
  const grokLogin = new GrokLoginService(grokAccounts.homes, grokAccounts.store, () => registry.adapter('grok').cli.executable())
  const copilotAccounts = { store: new CopilotAccountStore(db), homes: new CopilotAccountHomes(config.paths.copilotAccounts) }
  const copilotLogin = new CopilotLoginService(copilotAccounts.homes, copilotAccounts.store, () => registry.adapter('copilot').cli.executable())
  // What each turn consumed, and the public prices the dashboard applies to it.
  const turnUsage = new TurnUsageRecorder(db, undefined, { accounts: config.paths.antigravityAccounts, user: userAntigravityHome() })
  const prices = new PriceCatalog(db)
  const sessions = new SessionManager(db, log, config, registry, secrets, claudeAccounts, codexAccounts, grokAccounts, antigravityAccounts, copilotAccounts, turnUsage)
  // Agent browsers (tool family `browser`): launched on the agent's first use, closed when idle.
  const browsers = new BrowserManager(db, config)
  sessions.setBrowsers(browsers)
  // Dev-server previews on their own loopback listener (Server only; Desktop opens ports directly).
  const previews = INSTANCE_PROFILE === 'desktop' ? null : new PreviewService(db, config)
  const antigravityLogin = new AntigravityLoginService(antigravityAccounts.homes, antigravityAccounts.store, () => registry.adapter('antigravity').cli.executable(), (id) => sessions.stopAntigravityAccount(id))
  const attachments = new AttachmentStore(db, config.paths.attachments, conversationMediaRoot(config.paths.data))
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
  const worktreeStatus = new WorktreeStatusService(db, log, new WorktreeRemoteStatus(db, gitCredentials, config.paths))
  const decisions = new DecisionService({ db, config }, sessions, notifications)
  // Sessions stopped by a usage limit: one notification, and a resume after the reset when the
  // account allows it.
  const usageLimits = new UsageLimitResumeService(db, log, sessions, notifications)
  // Cleaning work closes terminals and archives sessions; detected merges
  // propose cleanup in 'To decide'.
  const worktreeCleanup = new WorktreeCleanup(db, config.paths.data, worktreeStatus, terminals, (id) => sessions.dropCheckpoints(id))
  watchMergedCards(db, worktreeStatus)
  // GitHub issue-linked board reads repositories, publishes local changes,
  // and opens maintenance sessions triggered by issues or comments.
  const board = new BoardSync({ db, config }, gitCredentials, fetch, new BoardResponder({ db, config }, sessions, registry))
  // Session launches and cards requested by agents through MCP.
  const agentRequests = new AgentRequests({ db, config }, sessions, registry, actions, encryptionKey, board, decisions, log, worktreeStatus, attachments, terminals, worktreeCleanup)
  // User- or agent-scheduled tasks executed in fresh sessions.
  const tasks = new TaskScheduler({ db, config }, sessions, registry, log, notifications)
  // Model benchmarks: fresh personal sessions measured from their journals.
  const benchmarkRunner = new BenchmarkRunner({ db, config }, sessions, registry, log, attachments, prices)

  // Otherwise uploads never sent would accumulate indefinitely.
  const orphans = await attachments.purgeOrphans()
  const orphanMedia = await attachments.purgeOrphanMedia()

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
    copilotAccounts,
    copilotLogin,
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
    benchmarkRunner,
    prices,
    turnUsage,
    browsers,
    previews,
  )
  push.setLogger(app.log)
  automations.setLogger(app.log)
  if (orphans > 0) app.log.info({ orphans }, 'pieces jointes orphelines supprimees')
  if (orphanMedia > 0) app.log.info({ media: orphanMedia }, 'orphan conversation media folders removed')
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
  benchmarkRunner.start(app.log)
  board.start(app.log)
  decisions.start(app.log)
  usageLimits.start(app.log)
  prices.start()

  // Before card #127, catalog probes opened their sessions in the home folder, where Antigravity
  // left its system skills. Before listening: no Antigravity session can be running there yet.
  try { removeMaterializedSystemSkills(homedir()) } catch (err) { app.log.warn({ err }, 'Antigravity system skills cleanup failed') }
  await app.listen({ host: config.server.host, port: config.server.port })
  // A busy preview port must not keep Sillage down: previews answer nothing, and the log says why.
  if (previews) {
    await previews.listen().then(
      () => app.log.info({ port: previews.listenerPort }, 'preview listener ready'),
      (err: unknown) => app.log.warn({ err, port: previews.listenerPort }, 'preview listener unavailable'),
    )
  }
  // After listening: reading years of journals must not delay the first page.
  void turnUsage.importHistory().catch((err: unknown) => app.log.warn({ err }, 'Turn usage history import failed'))

  // Desktop waits for this announcement before opening windows: servers already
  // respond and user sessions are ready for cookies.
  if (INSTANCE_PROFILE === 'desktop') {
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : config.server.port
    announceToLauncher(port, await openDesktopSession(db), Boolean(app.remoteAccess?.allowed()))
    // After the announcement: the Tailscale CLI may take seconds, and the window must not wait.
    const listening = app.remoteAccess?.listening(port)
    if (listening) detach(listening, 'remote access announcement')
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
        if (upgraded.length > 0) app.log.info({ repos: upgraded }, 'git helper of cloned repositories updated')
      })
      .catch((err: unknown) => app.log.warn({ err }, 'could not update the git helper of repositories'))
  } catch (err) {
    // Incomplete installations without `.mjs` still serve without helpers.
    app.log.warn({ err }, 'git helper launcher not installed')
  }

  // Shutdown requests may overlap (signals followed by desktop closing stdin):
  // the second must not close resources already closed by the first.
  let stopping = false
  const shutdown = async (signal: string, code = 0) => {
    if (stopping) return
    stopping = true
    app.log.info({ signal }, 'shutting down')
    // A step that hangs (a client socket that never closes, a CLI that ignores its signal) must
    // not keep the process alive until systemd kills it: the Desktop launcher gives it 15 s.
    setTimeout(() => {
      console.error('sillage: shutdown did not finish in time, exiting')
      process.exit(code || 1)
    }, SHUTDOWN_DEADLINE_MS).unref()
    // Each step on its own: one that throws used to skip the rest, leaving CLIs unstopped and
    // the database open.
    const step = async (name: string, run: () => unknown) => {
      try {
        await run()
      } catch (err) {
        app.log.error({ err, step: name }, 'shutdown step failed')
      }
    }
    // Before stopAll expires requests: statuses still identify in-flight work,
    // and persisted deliveries will send at next startup.
    await step('webhooks', () => { webhooks.shutdownFlush(); webhooks.stop() })
    // Every producer of new work stops before the runners do, or it could start a CLI after the
    // snapshot `stopAll` takes. `stopAll` itself refuses any new runner from then on.
    for (const [name, service] of [['scheduler', scheduler], ['relay', relay], ['agentRequests', agentRequests], ['tasks', tasks],
      ['board', board], ['decisions', decisions], ['benchmarks', benchmarkRunner], ['usageLimits', usageLimits]] as const) {
      await step(name, () => service.stop())
    }
    await step('antigravityLogin', () => antigravityLogin.closeAll())
    await step('copilotLogin', () => copilotLogin.closeAll())
    await step('sessions', () => sessions.stopAll())
    await step('terminals', () => terminals.shutdown())
    await step('browsers', () => browsers.shutdown())
    await step('previews', () => previews?.close())
    await step('http', () => app.close())
    await step('database', () => sqlite.close())
    lock.release()
    process.exit(code)
  }
  stopForFault = () => shutdown('uncaughtException', 1)
  // A failed step used to end the process through the unhandled rejection; now that rejections
  // are only logged, exit explicitly or the daemon would linger half stopped.
  const requestShutdown = (signal: string) =>
    shutdown(signal).catch((err: unknown) => {
      console.error('sillage: shutdown failed', err)
      process.exit(1)
    })
  process.on('SIGINT', () => detach(requestShutdown('SIGINT'), 'shutdown'))
  process.on('SIGTERM', () => detach(requestShutdown('SIGTERM'), 'shutdown'))
  // Desktop requests shutdown by closing stdin: Windows has no appropriate signal,
  // and killing servers would orphan session CLIs.
  // Stdin also closes on unexpected app death, taking the server with it.
  if (INSTANCE_PROFILE === 'desktop') {
    process.stdin.on('end', () => detach(requestShutdown('launcher'), 'shutdown'))
    process.stdin.resume()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
