import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentConfig,
  AgentKind,
  ScheduleCadence,
  ScheduleOverlapPolicy,
  ScheduledRunDto,
  ScheduledTaskDto,
} from '@sillage/protocol'
import { api } from './api'
import { locale, translate, type MessageKey } from './i18n'

export const SCHEDULES_KEY = ['schedules']

/**
 * Toutes les tâches planifiées visibles, tous projets confondus : la sidebar et la page
 * Planification lisent la même liste, filtrée par projet.
 *
 * Relue périodiquement : un tir part et finit sans qu'aucune requête de l'interface
 * l'ait provoqué, et l'état d'une tâche n'a pas de canal poussé à lui. Le premier statut
 * d'un fil neuf déclenche aussi une relecture, voir `useStatusFeed`.
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
  name: string
  agent: AgentKind
  config: AgentConfig
  prompt: string
  cadence: ScheduleCadence
  overlapPolicy: ScheduleOverlapPolicy
  maxDurationMinutes: number
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY })
    // Un tir lancé ou une tâche supprimée changent aussi la liste des fils.
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
    mutationFn: (id: string) => api.post<ScheduledRunDto>(`/api/schedules/${id}/run`),
    onSuccess: invalidate,
  })
}

/**
 * Ce que la tâche est en train de faire, en un mot : c'est l'état de sa ligne.
 *
 * Le tir en cours prime sur la pause : une tâche mise en pause pendant un tir tourne
 * encore, et l'afficher « en pause » cacherait la session qui travaille.
 */
export type ScheduleState = 'running' | 'paused' | 'failed' | 'done' | 'waiting'

export const SCHEDULE_STATE_LABELS: Record<ScheduleState, MessageKey> = {
  running: 'schedule.state.running',
  paused: 'schedule.state.paused',
  failed: 'schedule.state.failed',
  done: 'schedule.state.done',
  waiting: 'schedule.state.waiting',
}

export function scheduleState(task: ScheduledTaskDto): ScheduleState {
  // Les tirs sautés ne disent rien de la santé de la tâche : on lit le dernier vrai.
  const last = task.runs.find((run) => run.status !== 'skipped')
  if (last?.status === 'running') return 'running'
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

/** La cadence en clair ; le motif cron est traduit par l'appelant, qui a `cronToHuman`. */
export function describeCadence(cadence: ScheduleCadence, cronHuman: (expression: string) => string | null): string {
  if (cadence.kind === 'interval') return formatMinutes(cadence.minutes)
  if (cadence.kind === 'once') return translate('schedule.cadence.onceAt', { date: formatDateTime(cadence.at) })
  return cronHuman(cadence.expression) ?? cadence.expression
}
