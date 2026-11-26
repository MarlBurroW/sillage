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
import { LoginPage } from './routes/LoginPage'
import { BoardPage } from './routes/BoardPage'
import { ProjectPage } from './routes/ProjectPage'
import { NewProjectPage } from './routes/NewProjectPage'
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
// Screens opened now and then, off the main path of projects and conversations: the main bundle
// must stay under the PWA precache limit, and every lazy chunk is precached all the same.
const DiscussionFilesPage = lazyWithReload(() => import('./routes/DiscussionFilesPage').then((module) => ({ default: module.DiscussionFilesPage })))
const PersonalMemoryPage = lazyWithReload(() => import('./routes/PersonalMemoryPage').then((module) => ({ default: module.PersonalMemoryPage })))
const BenchmarksPage = lazyWithReload(() => import('./routes/BenchmarksPage').then((module) => ({ default: module.BenchmarksPage })))
const ServicesPage = lazyWithReload(() => import('./routes/ServicesPage').then((module) => ({ default: module.ServicesPage })))
const SchedulePage = lazyWithReload(() => import('./routes/SchedulePage').then((module) => ({ default: module.SchedulePage })))
const DecisionsPage = lazyWithReload(() => import('./routes/DecisionsPage').then((module) => ({ default: module.DecisionsPage })))
// Settings sections: only the layout and its section list stay in the main bundle. The agent
// tools section stays eager because ProjectPage shows the same component.
const AboutSection = lazyWithReload(() => import('./routes/AboutSection').then((module) => ({ default: module.AboutSection })))
const AccountSection = lazyWithReload(() => import('./routes/AccountSection').then((module) => ({ default: module.AccountSection })))
const ArchivingSettingsPage = lazyWithReload(() => import('./routes/ArchivingSettingsPage').then((module) => ({ default: module.ArchivingSettingsPage })))
const RemoteAccessSettingsPage = lazyWithReload(() => import('./routes/RemoteAccessSettingsPage').then((module) => ({ default: module.RemoteAccessSettingsPage })))
const AppearanceSection = lazyWithReload(() => import('./routes/AppearanceSection').then((module) => ({ default: module.AppearanceSection })))
const CliVersionsSettingsPage = lazyWithReload(() => import('./routes/CliVersionsSettingsPage').then((module) => ({ default: module.CliVersionsSettingsPage })))
const CliDefaultsSettingsPage = lazyWithReload(() => import('./routes/CliDefaultsSettingsPage').then((module) => ({ default: module.CliDefaultsSettingsPage })))
const DictationSettingsPage = lazyWithReload(() => import('./routes/DictationSettingsPage').then((module) => ({ default: module.DictationSettingsPage })))
const McpSettingsPage = lazyWithReload(() => import('./routes/McpSettingsPage').then((module) => ({ default: module.McpSettingsPage })))
const InstructionsSettingsPage = lazyWithReload(() => import('./routes/InstructionsSettingsPage').then((module) => ({ default: module.InstructionsSettingsPage })))
const SkillLibrarySettingsPage = lazyWithReload(() => import('./routes/SkillLibrarySettingsPage').then((module) => ({ default: module.SkillLibrarySettingsPage })))
const NotificationsSection = lazyWithReload(() => import('./routes/NotificationsSection').then((module) => ({ default: module.NotificationsSection })))
const ApiTokensSettingsPage = lazyWithReload(() => import('./routes/ApiTokensSettingsPage').then((module) => ({ default: module.ApiTokensSettingsPage })))
const GitCredentialsSettingsPage = lazyWithReload(() => import('./routes/GitCredentialsSettingsPage').then((module) => ({ default: module.GitCredentialsSettingsPage })))
const ClaudeAccountsSettingsPage = lazyWithReload(() => import('./routes/ClaudeAccountsSettingsPage').then((module) => ({ default: module.ClaudeAccountsSettingsPage })))
const CodexAccountsSettingsPage = lazyWithReload(() => import('./routes/CodexAccountsSettingsPage').then((module) => ({ default: module.CodexAccountsSettingsPage })))
const GrokAccountsSettingsPage = lazyWithReload(() => import('./routes/GrokAccountsSettingsPage').then((module) => ({ default: module.GrokAccountsSettingsPage })))
const AntigravityAccountsSettingsPage = lazyWithReload(() => import('./routes/AntigravityAccountsSettingsPage').then((module) => ({ default: module.AntigravityAccountsSettingsPage })))
const SecretsSettingsPage = lazyWithReload(() => import('./routes/SecretsSettingsPage').then((module) => ({ default: module.SecretsSettingsPage })))
const SessionsSettingsPage = lazyWithReload(() => import('./routes/SessionsSettingsPage').then((module) => ({ default: module.SessionsSettingsPage })))
const PreviewSettingsPage = lazyWithReload(() => import('./routes/PreviewSettingsPage').then((module) => ({ default: module.PreviewSettingsPage })))
const UsageLimitsSettingsPage = lazyWithReload(() => import('./routes/UsageLimitsSettingsPage').then((module) => ({ default: module.UsageLimitsSettingsPage })))
const UsersSettingsPage = lazyWithReload(() => import('./routes/UsersSettingsPage').then((module) => ({ default: module.UsersSettingsPage })))
const NewsSettingsPage = lazyWithReload(() => import('./routes/NewsSettingsPage').then((module) => ({ default: module.NewsSettingsPage })))
const RadioSettingsPage = lazyWithReload(() => import('./routes/RadioSettingsPage').then((module) => ({ default: module.RadioSettingsPage })))
import { AgentToolsSettingsPage } from './components/agent-tools/AgentTools'
import { SettingsLayout } from './routes/SettingsPage'

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
          <Route path="/discussions/files" element={<Suspense fallback={null}><DiscussionFilesPage /></Suspense>} />
          <Route path="/discussions/memory" element={<Suspense fallback={null}><PersonalMemoryPage /></Suspense>} />
          <Route path="/discussions/:conversationId" element={<ConversationPage key="personal" />} />
          <Route path="/benchmarks" element={<Suspense fallback={null}><BenchmarksPage /></Suspense>} />
          <Route path="/benchmarks/new" element={<Suspense fallback={null}><NewBenchmarkPage /></Suspense>} />
          <Route path="/benchmarks/:id" element={<Suspense fallback={null}><BenchmarkPage /></Suspense>} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/services" element={<Suspense fallback={null}><ServicesPage /></Suspense>} />
          <Route path="/consumption" element={<Suspense fallback={null}><ConsumptionPage /></Suspense>} />
          <Route path="/decisions" element={<Suspense fallback={null}><DecisionsPage /></Suspense>} />
          <Route path="/wall" element={<Suspense fallback={null}><WallPage /></Suspense>} />
          <Route path="/p/:projectId" element={<ProjectPage />} />
          <Route path="/p/:projectId/board" element={<BoardPage />} />
          <Route path="/p/:projectId/schedules" element={<Suspense fallback={null}><SchedulePage /></Suspense>} />
          <Route path="/p/:projectId/schedules/:taskId" element={<Suspense fallback={null}><AutomationPage /></Suspense>} />
          {/* Before ID routes so new is not mistaken for a conversation. */}
          <Route path="/p/:projectId/c/new" element={<DraftConversationPage />} />
          <Route path="/p/:projectId/c/:conversationId" element={<ConversationPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="compte" element={<Suspense fallback={null}><AccountSection /></Suspense>} />
            <Route path="apparence" element={<Suspense fallback={null}><AppearanceSection /></Suspense>} />
            <Route path="veille" element={<Suspense fallback={null}><NewsSettingsPage /></Suspense>} />
            <Route path="radio" element={<Suspense fallback={null}><RadioSettingsPage /></Suspense>} />
            <Route path="notifications" element={<Suspense fallback={null}><NotificationsSection /></Suspense>} />
            <Route path="cli" element={<Suspense fallback={null}><CliDefaultsSettingsPage /></Suspense>} />
            <Route path="cli-versions" element={<Suspense fallback={null}><CliVersionsSettingsPage /></Suspense>} />
            <Route path="limites" element={<Suspense fallback={null}><UsageLimitsSettingsPage /></Suspense>} />
            <Route path="projets" element={<Navigate to="/projects/new" replace />} />
            <Route path="mcp" element={<Suspense fallback={null}><McpSettingsPage /></Suspense>} />
            <Route path="consignes" element={<Suspense fallback={null}><InstructionsSettingsPage /></Suspense>} />
            <Route path="skills" element={<Suspense fallback={null}><SkillLibrarySettingsPage /></Suspense>} />
            <Route path="api" element={<Suspense fallback={null}><ApiTokensSettingsPage /></Suspense>} />
            <Route path="git" element={<Suspense fallback={null}><GitCredentialsSettingsPage /></Suspense>} />
            <Route path="comptes-claude" element={<Suspense fallback={null}><ClaudeAccountsSettingsPage /></Suspense>} />
            <Route path="comptes-codex" element={<Suspense fallback={null}><CodexAccountsSettingsPage /></Suspense>} />
            <Route path="comptes-grok" element={<Suspense fallback={null}><GrokAccountsSettingsPage /></Suspense>} />
            <Route path="comptes-antigravity" element={<Suspense fallback={null}><AntigravityAccountsSettingsPage /></Suspense>} />
            <Route path="secrets" element={<Suspense fallback={null}><SecretsSettingsPage /></Suspense>} />
            <Route path="dictee" element={<Suspense fallback={null}><DictationSettingsPage /></Suspense>} />
            <Route path="archivage" element={<Suspense fallback={null}><ArchivingSettingsPage /></Suspense>} />
            <Route path="acces-distant" element={<Suspense fallback={null}><RemoteAccessSettingsPage /></Suspense>} />
            <Route path="sessions" element={<Suspense fallback={null}><SessionsSettingsPage /></Suspense>} />
            <Route path="apercus" element={<Suspense fallback={null}><PreviewSettingsPage /></Suspense>} />
            <Route path="outils-agents" element={<AgentToolsSettingsPage />} />
            <Route path="comptes" element={<Suspense fallback={null}><UsersSettingsPage /></Suspense>} />
            <Route path="a-propos" element={<Suspense fallback={null}><AboutSection /></Suspense>} />
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
