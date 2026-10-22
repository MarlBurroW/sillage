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
 * All visible actions across projects: the panel filters its project while the palette offers
 * everything. Poll because agents propose actions without a socket-signaled route and service
 * states change independently.
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
 * Launch, control a service, or follow its logs. Bring newly opened terminals forward: clicking
 * without seeing output would appear to do nothing.
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
 * Current action state shared by panel, header launcher, and palette: common derivation prevents
 * one offering Launch while another shows the service running.
 */
export interface ActionView {
  /** A running service or a task whose command has not finished. */
  live: boolean
  failed: boolean
  /** Primary action for the circular button and palette. */
  primary: 'review' | 'run' | 'stop' | 'output'
  /** Address to open when the service is running and it is known. */
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

/** Action status sentence beneath its label. */
export function describeActionState(action: ProjectActionDto, t: (key: MessageKey, params?: MessageParams) => string): string {
  const { service, lastRun } = action
  const view = actionView(action)
  // Badges already convey review, running, and failure: the sentence supplies origin, listening
  // address, and next action.
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
