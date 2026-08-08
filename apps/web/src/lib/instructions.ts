import { useQuery } from '@tanstack/react-query'
import type { AgentKind } from '@sillage/protocol'
import { api } from './api'
import { openTab } from './editor-tabs'
import { setMarkdownView } from './markdown-view'
import { setPanelOpen, setPanelTab } from './panel'

/**
 * Fichier de consignes que le CLI lit à la racine du workspace.
 *
 * Chaque agent a le sien, mais tous acceptent aujourd'hui `AGENTS.md` : l'ordre dit
 * lequel montrer quand les deux existent, pas lequel est valide.
 */
const INSTRUCTION_FILES: Record<AgentKind, readonly string[]> = {
  claude: ['CLAUDE.md', 'AGENTS.md'],
  codex: ['AGENTS.md', 'CLAUDE.md'],
}

/**
 * Le fichier de consignes de ce workspace, ou null s'il n'y en a pas.
 *
 * Le raccourci disparaît alors de l'en-tête : proposer d'ouvrir un fichier absent
 * mènerait à une erreur de lecture, et le créer n'est pas ce qu'on demande en cliquant.
 */
export function useInstructionsFile(
  conversationId: string | undefined,
  agent: AgentKind | undefined,
): string | null {
  const candidates = agent ? INSTRUCTION_FILES[agent] : []

  const { data } = useQuery({
    queryKey: ['conversations', conversationId ?? '', 'instructions', agent ?? ''],
    queryFn: () =>
      api.post<{ files: string[] }>(`/api/conversations/${conversationId}/files/exist`, {
        paths: [...candidates],
      }),
    enabled: Boolean(conversationId) && Boolean(agent),
    // Un fichier de consignes apparaît rarement en cours de session, et l'agent qui le
    // crée le fait au début : une vérification par ouverture de conversation suffit.
    staleTime: 5 * 60 * 1000,
  })

  return candidates.find((path) => data?.files.includes(path)) ?? null
}

/**
 * Ouvre les consignes dans l'éditeur, en rendu.
 *
 * Le mode est forcé parce que ce fichier se consulte, jamais par curiosité de sa syntaxe,
 * et le forcer met à jour la préférence : basculer ensuite en source vaut pour la suite,
 * comme partout ailleurs.
 */
export function openInstructions(conversationId: string, path: string): void {
  setMarkdownView('preview')
  openTab(conversationId, path)
  setPanelTab('files')
  setPanelOpen(true)
}
