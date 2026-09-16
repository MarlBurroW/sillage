import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { ConversationDto, ProjectDto } from '@sillage/protocol'
import { useCurrentUser } from './session'

const storageKey = (userId: string) => `sillage.lastContext:${userId}`
const contextPattern = /^\/p\/([\w-]+)\/(board|c\/([\w-]+))(?:\?[^#]*)?$/

/** Un ancien favori ne doit pas renvoyer vers un projet supprimé ou devenu privé. */
function accessible(path: string, projects: ProjectDto[], conversations: ConversationDto[]): boolean {
  const match = contextPattern.exec(path)
  if (!match || !projects.some((project) => project.id === match[1])) return false
  return match[2] === 'board' || match[3] === 'new' || conversations.some(
    (conversation) => conversation.id === match[3] && conversation.projectId === match[1],
  )
}

export function lastContext(userId: string, projects: ProjectDto[], conversations: ConversationDto[]): string | null {
  try {
    const path = localStorage.getItem(storageKey(userId))
    return path && accessible(path, projects, conversations) ? path : null
  } catch {
    return null
  }
}

/** Les réglages et la page d'accueil ne remplacent jamais le travail à reprendre. */
export function useRememberContext(): void {
  const { pathname, search } = useLocation()
  const { data: user } = useCurrentUser()
  useEffect(() => {
    const path = pathname + search
    // Mémoriser dès la navigation : attendre les listes perd une visite courte.
    // Les droits et l'existence du fil seront vérifiés au moment de la reprise.
    if (!user || !contextPattern.test(path)) return
    try {
      localStorage.setItem(storageKey(user.id), path)
    } catch {
      // Un stockage désactivé ne doit pas empêcher de naviguer.
    }
  }, [pathname, search, user])
}
