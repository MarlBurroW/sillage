import { createContext, useContext } from 'react'
import { ApiRequestError } from '../../../lib/api'
import type { WorkspaceScope } from '../../../lib/workspace-scope'

/**
 * Ce que l'onglet Git dit à la suite d'une action : un échec, ou le mot de git quand
 * il a quelque chose à dire (« Already up to date. »).
 *
 * Un avis peut proposer un remède : un push rejeté offre de forcer, une branche non
 * fusionnée de la supprimer quand même. C'est la différence avec une erreur affichée
 * telle quelle, qui oblige à retrouver l'action et à deviner l'option.
 */
export interface GitNotice {
  tone: 'critical' | 'info' | 'positive'
  text: string
  /** Code d'erreur du serveur, pour que l'interface reconnaisse le cas. */
  code?: string
  actions?: { label: string; run: () => void }[]
}

export interface GitPaneContext {
  scope: WorkspaceScope
  notify: (notice: GitNotice | null) => void
  /** Absent quand aucun éditeur n'est à portée. */
  openFile?: (path: string) => void
}

export const GitContext = createContext<GitPaneContext>({
  scope: '',
  notify: () => {},
})

export function useGitPane(): GitPaneContext {
  return useContext(GitContext)
}

/** L'avis critique qu'un échec d'action produit, code compris. */
export function failureNotice(error: unknown, fallback: string): GitNotice {
  if (error instanceof ApiRequestError) {
    return { tone: 'critical', text: error.message, code: error.code }
  }
  return { tone: 'critical', text: error instanceof Error ? error.message : fallback }
}
