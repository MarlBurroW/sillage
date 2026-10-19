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
// À la demande : l'explorateur et l'éditeur de script ne servent qu'ici, et le paquet
// principal n'a plus de marge sous la limite du précache.
const AutomationPage = lazy(() => import('./routes/AutomationPage').then((module) => ({ default: module.AutomationPage })))
// La visite ne sert qu'une fois par compte : son code, générateur de QR compris, n'a
// rien à faire dans le paquet principal.
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
import { DecisionsPage } from './routes/DecisionsPage'
import { SecretsSettingsPage } from './routes/SecretsSettingsPage'
import { SessionsSettingsPage } from './routes/SessionsSettingsPage'
import { SettingsLayout } from './routes/SettingsPage'
import { UsersSettingsPage } from './routes/UsersSettingsPage'

/** Après la visite : la création du premier projet s'il n'y en a aucun, sinon l'accueil. */
function OnboardingExit() {
  const { data: projects } = useProjects()
  if (!projects) return null
  return <Navigate to={projects.length === 0 ? '/projects/new' : '/'} replace />
}

export function App() {
  const { data: user, isPending } = useCurrentUser()
  // Attendu avec la session : les écrans lisent ses capacités sans état intermédiaire.
  const { data: instance, isPending: instancePending } = useInstance()
  // Les réglages du compte décident si la visite est due : attendus aussi, pour ne pas
  // dessiner l'application une fraction de seconde avant de l'ouvrir.
  const { data: settings, isPending: settingsPending } = useUserSettings(Boolean(user))

  // Écran vide plutôt qu'un spinner : la vérification de session est locale et brève,
  // un spinner qui clignote est plus désagréable que rien.
  if (isPending || instancePending || (user && settingsPending)) return null

  const onboarding = (
    <Suspense fallback={null}>
      <OnboardingPage />
    </Suspense>
  )

  if (!user) {
    // Une base sans compte n'a pas de page de connexion à proposer : la visite
    // commence par créer le premier compte, sur n'importe quelle adresse.
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

  // La visite due prend toute la place : rien d'autre à voir tant qu'elle n'est pas
  // finie ou passée, et elle reprend à son étape sur n'importe quel appareil.
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
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/decisions" element={<DecisionsPage />} />
          <Route path="/p/:projectId" element={<ProjectPage />} />
          <Route path="/p/:projectId/board" element={<BoardPage />} />
          <Route path="/p/:projectId/schedules" element={<SchedulePage />} />
          <Route path="/p/:projectId/schedules/:taskId" element={<Suspense fallback={null}><AutomationPage /></Suspense>} />
          {/* Avant l'identifiant : « new » ne doit pas être pris pour une conversation. */}
          <Route path="/p/:projectId/c/new" element={<DraftConversationPage />} />
          <Route path="/p/:projectId/c/:conversationId" element={<ConversationPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="compte" element={<AccountSection />} />
            <Route path="apparence" element={<AppearanceSection />} />
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
