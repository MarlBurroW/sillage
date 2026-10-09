import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  resolveActionUrl,
  type CreateProjectActionBody,
  type ProjectActionDto,
  type ProjectActionRunResult,
  type ServiceActionControl,
} from '@sillage/protocol'
import { api } from './api'
import { relativeDate } from './dates'
import type { MessageKey, MessageParams } from './i18n'
import { showTerminal } from './panel'

export const ACTIONS_KEY = ['actions']

/**
 * Toutes les actions visibles, tous projets confondus : le panneau filtre son projet,
 * la palette les propose toutes.
 *
 * Relue périodiquement : un agent en propose une sans passer par une route que le
 * socket signalerait, et l'état d'un service change sans qu'on y touche.
 */
export function useActions() {
  return useQuery({
    queryKey: ACTIONS_KEY,
    queryFn: () => api.get<ProjectActionDto[]>('/api/actions'),
    staleTime: 5_000,
    refetchInterval: 10_000,
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return (projectId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ACTIONS_KEY })
    if (projectId) void queryClient.invalidateQueries({ queryKey: ['terminals', projectId] })
  }
}

export function useCreateAction(projectId: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: CreateProjectActionBody) =>
      api.post<ProjectActionDto>(`/api/projects/${projectId}/actions`, input),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateAction() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<CreateProjectActionBody>) =>
      api.patch<ProjectActionDto>(`/api/actions/${id}`, patch),
    onSuccess: () => invalidate(),
  })
}

export function useApproveAction() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.post<ProjectActionDto>(`/api/actions/${id}/approve`),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteAction() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/actions/${id}`),
    onSuccess: () => invalidate(),
  })
}

/**
 * Lancer, piloter un service ou suivre son journal. Ce qui ouvre un terminal le met
 * devant : cliquer un bouton sans voir sa sortie donnerait l'impression qu'il n'a rien fait.
 */
export function useRunAction() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({
      action,
      op = 'run',
      conversationId,
    }: {
      action: ProjectActionDto
      op?: 'run' | 'logs' | ServiceActionControl
      conversationId?: string
    }) =>
      api.post<ProjectActionRunResult>(
        op === 'run' ? `/api/actions/${action.id}/run` : `/api/actions/${action.id}/service/${op}`,
        conversationId ? { conversationId } : {},
      ),
    onSuccess: (result, { action }) => {
      invalidate(action.projectId)
      if (result.terminal) showTerminal(result.terminal.id)
    },
  })
}

const RUNNING_STATES = ['active', 'activating', 'reloading']

/**
 * Ce qu'une action est en ce moment, lu de la même façon par le panneau, le lanceur
 * de l'en-tête et la palette : sans ce calcul commun, l'un proposerait « Lancer » pendant
 * que l'autre montre le service en marche.
 */
export interface ActionView {
  /** Un service qui tourne, ou une tâche dont la commande n'est pas finie. */
  live: boolean
  failed: boolean
  /** Le geste principal, celui du disque et de la palette. */
  primary: 'review' | 'run' | 'stop' | 'output'
  /** Adresse à ouvrir, quand le service tourne et qu'elle est connue. */
  href: string | null
}

export function actionView(action: ProjectActionDto): ActionView {
  const { service, lastRun } = action
  const live = service ? RUNNING_STATES.includes(service.state) : (lastRun?.alive ?? false)
  const failed = service
    ? service.state === 'failed'
    : lastRun !== null && !lastRun.alive && lastRun.exitCode !== null && lastRun.exitCode !== 0
  const primary =
    action.status === 'proposed' ? 'review' : service && live ? 'stop' : live ? 'output' : 'run'
  return { live, failed, primary, href: service && live ? resolveActionUrl(action.url, service.ports) : null }
}

/** La phrase d'état d'une action, sous son libellé. */
export function describeActionState(action: ProjectActionDto, t: (key: MessageKey, params?: MessageParams) => string): string {
  const { service, lastRun } = action
  const view = actionView(action)
  // Les badges disent déjà « à relire », « en marche », « en échec » : la phrase
  // donne ce qu'ils ne peuvent pas dire, d'où vient l'action, où elle écoute, quoi faire.
  if (action.status === 'proposed') {
    return t('actions.state.proposedIn', { title: action.agentConversationTitle ?? t('actions.proposedInGone') })
  }
  if (service) {
    if (view.live) {
      return service.ports.length > 0
        ? t('actions.state.runningPorts', { ports: service.ports.map((port) => `:${port}`).join(' ') })
        : t('actions.state.running')
    }
    return view.failed ? t('actions.state.failed') : t('actions.state.stopped')
  }
  if (!lastRun) return t('actions.state.neverRun')
  if (lastRun.alive) return t('actions.state.taskRunning')
  const when = relativeDate(lastRun.startedAt)
  if (lastRun.exitCode === null) return t('actions.state.taskInterrupted', { when })
  return lastRun.exitCode === 0
    ? t('actions.state.taskOk', { when })
    : t('actions.state.taskFailed', { code: lastRun.exitCode, when })
}
