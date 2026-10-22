import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { ConversationDto, ProjectDto } from '@sillage/protocol'
import { useCurrentUser } from './session'

const storageKey = (userId: string) => `sillage.lastContext:${userId}`
const contextPattern = /^\/p\/([\w-]+)\/(board|c\/([\w-]+))(?:\?[^#]*)?$/

/** Old bookmarks must not reopen deleted or newly private projects. */
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

/** Settings and home never replace the work to resume. */
export function useRememberContext(): void {
  const { pathname, search } = useLocation()
  const { data: user } = useCurrentUser()
  useEffect(() => {
    const path = pathname + search
    // Remember on navigation: waiting for lists loses short visits. Check permissions and thread
    // existence on resume.
    if (!user || !contextPattern.test(path)) return
    try {
      localStorage.setItem(storageKey(user.id), path)
    } catch {
      // Disabled storage must not prevent navigation.
    }
  }, [pathname, search, user])
}
