import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentConfig,
  AutomationTemplateId,
  WebhookSettings,
  AgentKind,
  ScheduleCadence,
  ScheduleOverlapPolicy,
  ScheduleCheckResultDto,
  ScheduledRunDto,
  ScheduledTaskDto,
} from '@sillage/protocol'
import { api } from './api'
import { locale, translate, type MessageKey } from './i18n'

export const SCHEDULES_KEY = ['schedules']

/**
 * All visible scheduled tasks across projects: sidebar and scheduling page share this list filtered
 * by project. Poll because runs start and finish independently of UI requests and tasks have no
 * dedicated push channel. The first status of a new thread also triggers a refetch; see
 * `useStatusFeed`.
 */
export function useSchedules() {
  return useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: () => api.get<ScheduledTaskDto[]>('/api/schedules'),
    staleTime: 10_000,
    refetchInterval: 20_000,
  })
}

export interface ScheduleInput {
  /** Starting template when creating a webhook automation. */
  webhook?: { template?: AutomationTemplateId; settings?: Partial<WebhookSettings> }
  name: string
  agent: AgentKind
  config: AgentConfig
  prompt: string
  cadence: ScheduleCadence
  overlapPolicy: ScheduleOverlapPolicy
  maxDurationMinutes: number
  /** Null removes the check. */
  checkScript?: string | null
  checkTimeoutSeconds?: number
  /** The agent may request a decision, waiting at most `decisionMaxHours`. */
  decisionsEnabled?: boolean
  decisionMaxHours?: number
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY })
    // Starting a run or deleting a task also changes the thread list.
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
  }
}

export function useCreateSchedule(projectId: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: ScheduleInput) =>
      api.post<ScheduledTaskDto>(`/api/projects/${projectId}/schedules`, input),
    onSuccess: invalidate,
  })
}

export function useUpdateSchedule() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<ScheduleInput & { enabled: boolean }>) =>
      api.patch<ScheduledTaskDto>(`/api/schedules/${id}`, patch),
    onSuccess: invalidate,
  })
}

export function useDeleteSchedule() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/schedules/${id}`),
    onSuccess: invalidate,
  })
}

export function useRunSchedule() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, skipCheck = false }: { id: string; skipCheck?: boolean }) =>
      api.post<ScheduledRunDto>(`/api/schedules/${id}/run`, { skipCheck }),
    onSuccess: invalidate,
  })
}

/** Run a check script without starting a task; cache nothing. */
export function useTestScheduleCheck(projectId: string) {
  return useMutation({
    mutationFn: (input: { script: string; timeoutSeconds: number; taskId?: string }) =>
      api.post<ScheduleCheckResultDto>(`/api/projects/${projectId}/schedules/check-test`, input),
  })
}

export function useApproveScheduleCheck() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, script }: { id: string; script: string }) =>
      api.post<ScheduledTaskDto>(`/api/schedules/${id}/check/approve`, { script }),
    onSuccess: invalidate,
  })
}

/**
 * One-word task activity for its row state. An active run takes precedence over pause: pausing
 * during a run does not stop it, so displaying paused would hide the working session.
 */
export type ScheduleState = 'running' | 'approval' | 'paused' | 'failed' | 'done' | 'waiting'

export const SCHEDULE_STATE_LABELS: Record<ScheduleState, MessageKey> = {
  running: 'schedule.state.running',
  approval: 'schedule.state.approval',
  paused: 'schedule.state.paused',
  failed: 'schedule.state.failed',
  done: 'schedule.state.done',
  waiting: 'schedule.state.waiting',
}

export function scheduleState(task: ScheduledTaskDto): ScheduleState {
  // Skipped runs say nothing about task health: inspect the latest actual run.
  const last = task.runs.find((run) => run.status !== 'skipped')
  if (last?.status === 'running' || last?.status === 'checking') return 'running'
  // Before pause: a task awaiting approval does nothing until granted, the only action needed from the viewer.
  if (task.check && !task.check.approved && !task.webhook) return 'approval'
  if (!task.enabled) return task.cadence.kind === 'once' && task.lastRunAt ? 'done' : 'paused'
  if (last?.status === 'failed' || last?.status === 'timed_out') return 'failed'
  return 'waiting'
}

function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return translate('schedule.cadence.days', { count: minutes / 1440 })
  if (minutes % 60 === 0) return translate('schedule.cadence.hours', { count: minutes / 60 })
  return translate('schedule.cadence.minutes', { count: minutes })
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(locale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Readable cadence; the caller translates cron patterns with `cronToHuman`. */
export function describeCadence(cadence: ScheduleCadence, cronHuman: (expression: string) => string | null): string {
  if (cadence.kind === 'interval') return formatMinutes(cadence.minutes)
  if (cadence.kind === 'once') return translate('schedule.cadence.onceAt', { date: formatDateTime(cadence.at) })
  if (cadence.kind === 'webhook') return translate('schedule.cadence.webhook')
  return cronHuman(cadence.expression) ?? cadence.expression
}
