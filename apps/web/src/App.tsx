import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { useCurrentUser } from './lib/session'
import { DesignPage } from './routes/DesignPage'
import { ConversationPage } from './routes/ConversationPage'
import { DraftConversationPage } from './routes/DraftConversationPage'
import { HomePage } from './routes/HomePage'
import { LoginPage } from './routes/LoginPage'
import { ProjectPage } from './routes/ProjectPage'
import { ProjectsSettingsPage } from './routes/ProjectsSettingsPage'
import { AccountSection } from './routes/AccountSection'
import { AppearanceSection } from './routes/AppearanceSection'
import { NotificationsSection } from './routes/NotificationsSection'
import { SettingsLayout } from './routes/SettingsPage'
import { UsersSettingsPage } from './routes/UsersSettingsPage'

export function App() {
  const { data: user, isPending } = useCurrentUser()

  // Écran vide plutôt qu'un spinner : la vérification de session est locale et brève,
  // un spinner qui clignote est plus désagréable que rien.
  if (isPending) return null

  if (!user) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/p/:projectId" element={<ProjectPage />} />
          {/* Avant l'identifiant : « new » ne doit pas être pris pour une conversation. */}
          <Route path="/p/:projectId/c/new" element={<DraftConversationPage />} />
          <Route path="/p/:projectId/c/:conversationId" element={<ConversationPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="compte" element={<AccountSection />} />
            <Route path="apparence" element={<AppearanceSection />} />
            <Route path="notifications" element={<NotificationsSection />} />
            <Route path="projets" element={<ProjectsSettingsPage />} />
            <Route path="comptes" element={<UsersSettingsPage />} />
          </Route>
          <Route path="/design" element={<DesignPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
