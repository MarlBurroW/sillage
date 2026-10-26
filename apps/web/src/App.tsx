import { DiscussionFilesPage } from './routes/DiscussionFilesPage'
import { PersonalMemoryPage } from './routes/PersonalMemoryPage'
import { NewsSettingsPage } from './routes/NewsSettingsPage'
import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { useInstance } from './lib/instance'
import { useCurrentUser } from './lib/session'
import { useUserSettings } from './lib/user-settings'
import { useProjects } from './lib/projects'
import { DesignPage } from './routes/DesignPage'
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
const AutomationPage = lazy(() => import('./routes/AutomationPage').then((module) => ({ default: module.AutomationPage })))
// Onboarding runs once per account: its code, including QR generation, does not belong in the main bundle.
const OnboardingPage = lazy(() => import('./routes/OnboardingPage').then((module) => ({ default: module.OnboardingPage })))
import { AboutSection } from './routes/AboutSection'
import { AccountSection } from './routes/AccountSection'
import { ArchivingSettingsPage } from './routes/ArchivingSettingsPage'
import { AppearanceSection } from './routes/AppearanceSection'
import { CliDefaultsSettingsPage } from './routes/CliDefaultsSettingsPage'
import { DictationSettingsPage } from './routes/DictationSettingsPage'
import { McpSettingsPage } from './routes/McpSettingsPage'
import { SkillEditorPage } from './routes/SkillEditorPage'
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
import { SettingsLayout } from './routes/SettingsPage'
import { UsersSettingsPage } from './routes/UsersSettingsPage'

/** After onboarding: create the first project if none exists, otherwise show home. */
function OnboardingExit() {
  const { data: projects } = useProjects()
  if (!projects) return null
  return <Navigate to={projects.length === 0 ? '/projects/new' : '/'} replace />
}

export function App() {
  const { data: user, isPending } = useCurrentUser()
  // Await with the session so screens read capabilities without an intermediate state.
  const { data: instance, isPending: instancePending } = useInstance()
  // Account settings determine whether onboarding is due: await them too to avoid briefly rendering
  // the app before opening it.
  const { data: settings, isPending: settingsPending } = useUserSettings(Boolean(user))

  // Blank screen rather than spinner: session checks are local and brief, so a flashing spinner is
  // more distracting than nothing.
  if (isPending || instancePending || (user && settingsPending)) return null

  const onboarding = (
    <Suspense fallback={null}>
      <OnboardingPage />
    </Suspense>
  )

  if (!user) {
    // A database with no account has no login page to offer: onboarding starts by creating the
    // first account at any address.
    if (instance?.needsSetup && instance.capabilities.passwordAuth) {
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
  if (settings?.onboarding.pending) {
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
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/decisions" element={<DecisionsPage />} />
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
            <Route path="notifications" element={<NotificationsSection />} />
            <Route path="cli" element={<CliDefaultsSettingsPage />} />
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
            <Route path="sessions" element={<SessionsSettingsPage />} />
            <Route path="comptes" element={<UsersSettingsPage />} />
            <Route path="a-propos" element={<AboutSection />} />
          </Route>
          <Route path="/skills/:skillId" element={<SkillEditorPage />} />
          <Route path="/design" element={<DesignPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
