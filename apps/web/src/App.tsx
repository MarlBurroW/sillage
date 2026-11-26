import { DiscussionFilesPage } from './routes/DiscussionFilesPage'
import { PersonalMemoryPage } from './routes/PersonalMemoryPage'
import { BenchmarksPage } from './routes/BenchmarksPage'
import { NewsSettingsPage } from './routes/NewsSettingsPage'
import { RadioSettingsPage } from './routes/RadioSettingsPage'
import { Suspense, useEffect } from 'react'
import { lazyWithReload } from './lib/lazy-reload'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { dismissBootMark } from './lib/boot-mark'
import { useInstance } from './lib/instance'
import { useCurrentUser } from './lib/session'
import { useUserSettings } from './lib/user-settings'
import { ONBOARDING_EXIT_PARAM } from './lib/onboarding'
import { useProjects } from './lib/projects'
import { ConversationPage } from './routes/ConversationPage'
import { DraftConversationPage } from './routes/DraftConversationPage'
import { HomePage } from './routes/HomePage'
import { ServicesPage } from './routes/ServicesPage'
import { LoginPage } from './routes/LoginPage'
import { BoardPage } from './routes/BoardPage'
import { ProjectPage } from './routes/ProjectPage'
import { NewProjectPage } from './routes/NewProjectPage'
import { SchedulePage } from './routes/SchedulePage'
// Load on demand: explorer and script editor are used only here and the main bundle has no precache headroom.
const AutomationPage = lazyWithReload(() => import('./routes/AutomationPage').then((module) => ({ default: module.AutomationPage })))
// The wall pulls its own styles and query tooling: keep them out of the main bundle, close to the precache limit.
const ConsumptionPage = lazyWithReload(() => import('./routes/ConsumptionPage').then((module) => ({ default: module.ConsumptionPage })))
const WallPage = lazyWithReload(() => import('./routes/WallPage').then((module) => ({ default: module.WallPage })))
// Onboarding runs once per account: its code, including QR generation, does not belong in the main bundle.
const OnboardingPage = lazyWithReload(() => import('./routes/OnboardingPage').then((module) => ({ default: module.OnboardingPage })))
// The benchmark form carries the lineup editor and presets: only people creating a benchmark load them.
const NewBenchmarkPage = lazyWithReload(() => import('./routes/NewBenchmarkPage').then((module) => ({ default: module.NewBenchmarkPage })))
// Same for a benchmark's page, with its tables, comparison and outputs viewer.
const BenchmarkPage = lazyWithReload(() => import('./routes/BenchmarkPage').then((module) => ({ default: module.BenchmarkPage })))
// Rarely opened, and the main bundle sits at the PWA precache limit: kept out of it.
const SkillEditorPage = lazyWithReload(() => import('./routes/SkillEditorPage').then((module) => ({ default: module.SkillEditorPage })))
const DesignPage = lazyWithReload(() => import('./routes/DesignPage').then((module) => ({ default: module.DesignPage })))
// The main bundle sits near the 3 MiB precache cap: a page few people open loads on demand.
const ReleaseNotesSection = lazyWithReload(() => import('./routes/ReleaseNotesSection').then((module) => ({ default: module.ReleaseNotesSection })))
import { AboutSection } from './routes/AboutSection'
import { AccountSection } from './routes/AccountSection'
import { ArchivingSettingsPage } from './routes/ArchivingSettingsPage'
import { RemoteAccessSettingsPage } from './routes/RemoteAccessSettingsPage'
import { AppearanceSection } from './routes/AppearanceSection'
import { CliVersionsSettingsPage } from './routes/CliVersionsSettingsPage'
import { CliDefaultsSettingsPage } from './routes/CliDefaultsSettingsPage'
import { DictationSettingsPage } from './routes/DictationSettingsPage'
import { McpSettingsPage } from './routes/McpSettingsPage'
import { InstructionsSettingsPage } from './routes/InstructionsSettingsPage'
import { SkillLibrarySettingsPage } from './routes/SkillLibrarySettingsPage'
import { NotificationsSection } from './routes/NotificationsSection'
import { ApiTokensSettingsPage } from './routes/ApiTokensSettingsPage'
import { GitCredentialsSettingsPage } from './routes/GitCredentialsSettingsPage'
import { ClaudeAccountsSettingsPage } from './routes/ClaudeAccountsSettingsPage'
import { CodexAccountsSettingsPage } from './routes/CodexAccountsSettingsPage'
import { GrokAccountsSettingsPage } from './routes/GrokAccountsSettingsPage'
import { AntigravityAccountsSettingsPage } from './routes/AntigravityAccountsSettingsPage'
import { DecisionsPage } from './routes/DecisionsPage'
import { SecretsSettingsPage } from './routes/SecretsSettingsPage'
import { SessionsSettingsPage } from './routes/SessionsSettingsPage'
import { PreviewSettingsPage } from './routes/PreviewSettingsPage'
import { AgentToolsSettingsPage } from './components/agent-tools/AgentTools'
import { UsageLimitsSettingsPage } from './routes/UsageLimitsSettingsPage'
import { SettingsLayout } from './routes/SettingsPage'
import { UsersSettingsPage } from './routes/UsersSettingsPage'

/**
 * After onboarding: create the first project if none exists, otherwise show home. The tour may
 * name the sample project as its exit, which opens that form instead of the blank one.
 */
function OnboardingExit() {
  const { data: projects } = useProjects()
  if (!projects) return null
  if (projects.length > 0) return <Navigate to="/" replace />
  // Read from the address bar, where the tour wrote it (see `finish` in OnboardingPage).
  const sample = new URLSearchParams(window.location.search).get(ONBOARDING_EXIT_PARAM) === 'sample'
  return <Navigate to={sample ? '/projects/new?mode=sample' : '/projects/new'} replace />
}

/** Inside the boundary of a lazy first screen: takes the startup mark away once it is there. */
function BootMarkEnd() {
  useEffect(dismissBootMark, [])
  return null
}

export function App() {
  const { data: user, isPending } = useCurrentUser()
  // Await with the session so screens read capabilities without an intermediate state.
  const { data: instance, isPending: instancePending } = useInstance()
  // Account settings determine whether onboarding is due: await them too to avoid briefly rendering
  // the app before opening it.
  const { data: settings, isPending: settingsPending } = useUserSettings(Boolean(user))

  // Nothing of our own while the session is checked: the startup mark of index.html covers this
  // wait, and holds back in browsers, where a spinner flashing by distracts more than nothing.
  const booting = isPending || instancePending || Boolean(user && settingsPending)
  // Onboarding is due: this account's own, or the first account of a database without one.
  const welcome = Boolean(user ? settings?.onboarding.pending : instance?.needsSetup && instance.capabilities.passwordAuth)
  useEffect(() => {
    // The onboarding is a chunk of its own: the mark stays until it has loaded (BootMarkEnd).
    if (!booting && !welcome) dismissBootMark()
  }, [booting, welcome])
  if (booting) return null

  const onboarding = (
    <Suspense fallback={null}>
      <BootMarkEnd />
      <OnboardingPage />
    </Suspense>
  )

  if (!user) {
    // A database with no account has no login page to offer: onboarding starts by creating the
    // first account at any address.
    if (welcome) {
      return (
        <BrowserRouter>
          <Routes>
            <Route path="*" element={onboarding} />
          </Routes>
        </BrowserRouter>
      )
    }
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    )
  }

  // Due onboarding occupies the entire screen until finished or skipped and resumes at its saved
  // step on any device.
  if (welcome) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/bienvenue" element={onboarding} />
          <Route path="*" element={<Navigate to="/bienvenue" replace />} />
        </Routes>
      </BrowserRouter>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/bienvenue" element={<OnboardingExit />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/discussions" element={<Navigate to="/discussions/new" replace />} />
          <Route path="/discussions/new" element={<DraftConversationPage key="personal" />} />
          <Route path="/discussions/files" element={<DiscussionFilesPage />} />
          <Route path="/discussions/memory" element={<PersonalMemoryPage />} />
          <Route path="/discussions/:conversationId" element={<ConversationPage key="personal" />} />
          <Route path="/benchmarks" element={<BenchmarksPage />} />
          <Route path="/benchmarks/new" element={<Suspense fallback={null}><NewBenchmarkPage /></Suspense>} />
          <Route path="/benchmarks/:id" element={<Suspense fallback={null}><BenchmarkPage /></Suspense>} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/consumption" element={<Suspense fallback={null}><ConsumptionPage /></Suspense>} />
          <Route path="/decisions" element={<DecisionsPage />} />
          <Route path="/wall" element={<Suspense fallback={null}><WallPage /></Suspense>} />
          <Route path="/p/:projectId" element={<ProjectPage />} />
          <Route path="/p/:projectId/board" element={<BoardPage />} />
          <Route path="/p/:projectId/schedules" element={<SchedulePage />} />
          <Route path="/p/:projectId/schedules/:taskId" element={<Suspense fallback={null}><AutomationPage /></Suspense>} />
          {/* Before ID routes so new is not mistaken for a conversation. */}
          <Route path="/p/:projectId/c/new" element={<DraftConversationPage />} />
          <Route path="/p/:projectId/c/:conversationId" element={<ConversationPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="compte" element={<AccountSection />} />
            <Route path="apparence" element={<AppearanceSection />} />
            <Route path="veille" element={<NewsSettingsPage />} />
            <Route path="radio" element={<RadioSettingsPage />} />
            <Route path="notifications" element={<NotificationsSection />} />
            <Route path="cli" element={<CliDefaultsSettingsPage />} />
            <Route path="cli-versions" element={<CliVersionsSettingsPage />} />
            <Route path="limites" element={<UsageLimitsSettingsPage />} />
            <Route path="projets" element={<Navigate to="/projects/new" replace />} />
            <Route path="mcp" element={<McpSettingsPage />} />
            <Route path="consignes" element={<InstructionsSettingsPage />} />
            <Route path="skills" element={<SkillLibrarySettingsPage />} />
            <Route path="api" element={<ApiTokensSettingsPage />} />
            <Route path="git" element={<GitCredentialsSettingsPage />} />
            <Route path="comptes-claude" element={<ClaudeAccountsSettingsPage />} />
            <Route path="comptes-codex" element={<CodexAccountsSettingsPage />} />
            <Route path="comptes-grok" element={<GrokAccountsSettingsPage />} />
            <Route path="comptes-antigravity" element={<AntigravityAccountsSettingsPage />} />
            <Route path="secrets" element={<SecretsSettingsPage />} />
            <Route path="dictee" element={<DictationSettingsPage />} />
            <Route path="archivage" element={<ArchivingSettingsPage />} />
            <Route path="acces-distant" element={<RemoteAccessSettingsPage />} />
            <Route path="sessions" element={<SessionsSettingsPage />} />
            <Route path="apercus" element={<PreviewSettingsPage />} />
            <Route path="outils-agents" element={<AgentToolsSettingsPage />} />
            <Route path="comptes" element={<UsersSettingsPage />} />
            <Route path="a-propos" element={<AboutSection />} />
            <Route path="notes-de-version" element={<Suspense fallback={null}><ReleaseNotesSection /></Suspense>} />
          </Route>
          <Route path="/skills/:skillId" element={<Suspense fallback={null}><SkillEditorPage /></Suspense>} />
          <Route path="/design" element={<Suspense fallback={null}><DesignPage /></Suspense>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
