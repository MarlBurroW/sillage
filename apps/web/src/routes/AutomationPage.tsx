import {
  ArrowLeft,
  Bot,
  Check,
  Code2,
  Copy,
  Eye,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Webhook,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  MAX_AUTOMATION_RULES,
  MAX_AUTOMATION_RUNS_PER_HOUR,
  MAX_SCHEDULE_DURATION_MINUTES,
  MAX_SCHEDULE_NAME_CHARS,
  MIN_SCHEDULE_DURATION_MINUTES,
  agentKindSchema,
  defaultConfigFor,
  evaluateConditions,
  valueText,
  type AgentConfig,
  type AgentKind,
  type AutomationRule,
  type ProjectDto,
  type RuleResult,
  type ScheduleOverlapPolicy,
  type ScheduledTaskDto,
  type WebhookAutomationDto,
  type WebhookSettings,
  type WebhookVerification,
} from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { useAgentSettings } from '../components/chat/agent-settings'
import { ConditionsEditor } from '../components/automation/ConditionsEditor'
import { ScriptEditor } from '../components/automation/ScriptEditor'
import { TestBench, type BenchCall } from '../components/automation/TestBench'
import { GroupField } from '../components/schedule/GroupField'
import { DecisionSettingsField } from '../components/decisions/DecisionSettingsField'
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog, EmptyState, Field, IconButton, Select, cx } from '../components/ui'
import { automationSamples } from '../lib/automation-samples'
import {
  TEMPLATE_LABELS,
  absoluteHookUrl,
  benchEvent,
  formatHeaders,
  parseHeaders,
  useDeliveries,
  useDelivery,
  useRevealSecret,
  useRotateWebhook,
  useTestWebhook,
  useUpdateWebhook,
} from '../lib/automations'
import { useCopy } from '../lib/clipboard'
import { useTranslate } from '../lib/i18n'
import { useProjects } from '../lib/projects'
import { useSchedules, useUpdateSchedule } from '../lib/schedules'
import { useSidebarHidden } from '../lib/sidebar'
import { useUserSettings } from '../lib/user-settings'

function settingsOf(webhook: WebhookAutomationDto): WebhookSettings {
  const { verification, deliveryHeader, conditions, script, subjectPath, markerPaths, maxRunsPerHour } = webhook
  return { verification, deliveryHeader, conditions, script, subjectPath, markerPaths, maxRunsPerHour }
}

/** Ce que la session née d'un appel reçoit : son CLI, ses réglages, sa consigne. */
interface SessionDraft {
  agent: AgentKind
  config: AgentConfig
  maxDurationMinutes: number
  overlapPolicy: ScheduleOverlapPolicy
  prompt: string
  decisionsEnabled: boolean
  decisionMaxHours: number
}

function sessionOf(task: ScheduledTaskDto): SessionDraft {
  return {
    agent: task.agent,
    config: task.config,
    maxDurationMinutes: task.maxDurationMinutes,
    overlapPolicy: task.overlapPolicy,
    prompt: task.prompt,
    decisionsEnabled: task.decisionsEnabled,
    decisionMaxHours: task.decisionMaxHours,
  }
}

/** L'exemple qui ouvre le banc : celui du modèle, sinon le premier qui n'est pas un ping. */
function initialSample(template: WebhookAutomationDto['template']) {
  const samples = automationSamples()
  return samples.find((sample) => template && sample.templates.includes(template) && sample.id !== 'github_ping') ?? samples[0]!
}

function sampleCall(id: string): BenchCall {
  const sample = automationSamples().find((entry) => entry.id === id) ?? automationSamples()[0]!
  return {
    source: { kind: 'sample', id: sample.id },
    headersText: formatHeaders(sample.headers),
    body: JSON.stringify(sample.payload, null, 2),
    edited: false,
    truncated: false,
  }
}

/**
 * La page d'une automatisation déclenchée par webhook : sa configuration à gauche, en
 * quatre étapes, et un banc d'essai à droite.
 *
 * Le banc porte un appel, d'exemple ou réellement reçu, et dit en direct ce que
 * l'automatisation en ferait avec les réglages en cours, brouillon compris : verdict,
 * prompt rendu, script. On règle d'un côté, on vérifie de l'autre, sans rien lancer ;
 * le verdict vient du serveur, qui évaluera le prochain vrai appel de la même façon.
 */
export function AutomationPage() {
  const { projectId, taskId } = useParams()
  const t = useTranslate()
  const { data: schedules, isPending } = useSchedules()
  const task = schedules?.find((entry) => entry.id === taskId)

  if (isPending) return <p className="p-6 text-sm text-ink-faint">{t('schedule.loading')}</p>
  if (!task?.webhook) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Webhook size={22} />}
          title={t('automation.notFound')}
          action={<Link className="text-sm text-accent hover:underline" to={`/p/${projectId}/schedules`}>{t('automation.back')}</Link>}
        />
      </div>
    )
  }
  return <AutomationEditor key={task.id} task={task} webhook={task.webhook} />
}

function AutomationEditor({ task, webhook }: { task: ScheduledTaskDto; webhook: WebhookAutomationDto }) {
  const t = useTranslate()
  const sidebarHidden = useSidebarHidden()
  const { data: projects } = useProjects()
  const project = projects?.find((entry) => entry.id === task.projectId)
  const updateTask = useUpdateSchedule()
  const updateHook = useUpdateWebhook(task.id)

  // Un seul brouillon pour toute la page : les réglages du webhook et ceux de la session,
  // enregistrés ensemble. C'est ce qui permet de tout essayer avant de rien changer.
  const [baseline, setBaseline] = useState(() => ({ settings: settingsOf(webhook), session: sessionOf(task) }))
  const [settings, setSettings] = useState(baseline.settings)
  const [session, setSession] = useState(baseline.session)
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(baseline.settings)
  const sessionDirty = JSON.stringify(session) !== JSON.stringify(baseline.session)
  const dirty = settingsDirty || sessionDirty

  // Un changement venu d'ailleurs (autre onglet, agent) remplace le brouillon tant qu'il
  // n'a pas été touché ; un brouillon en cours, lui, n'est jamais écrasé.
  const server = JSON.stringify({ settings: settingsOf(webhook), session: sessionOf(task) })
  useEffect(() => {
    if (dirty) return
    const next = JSON.parse(server) as { settings: WebhookSettings; session: SessionDraft }
    setBaseline(next)
    setSettings(next.settings)
    setSession(next.session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server])

  const patch = (change: Partial<WebhookSettings>) => setSettings((current) => ({ ...current, ...change }))
  const patchSession = (change: Partial<SessionDraft>) => setSession((current) => ({ ...current, ...change }))
  const prompt = session.prompt
  const setPrompt = (value: string) => patchSession({ prompt: value })

  // --- Banc d'essai ---
  const deliveries = useDeliveries(task.id)
  const list = deliveries.data ?? []
  const [bench, setBench] = useState<BenchCall>(() => sampleCall(initialSample(webhook.template).id))
  // L'utilisateur a choisi ou retouché l'appel du banc : plus rien ne le remplace tout seul.
  const touched = useRef(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const loading = useDelivery(task.id, loadingId)

  const loadSample = (id: string) => {
    touched.current = true
    setLoadingId(null)
    setBench(sampleCall(id))
  }
  const loadDelivery = (id: string) => {
    touched.current = true
    setLoadingId(id)
  }
  useEffect(() => {
    const detail = loading.data
    if (!detail || detail.id !== loadingId) return
    setBench({
      source: { kind: 'delivery', id: detail.id },
      headersText: formatHeaders(detail.event.headers),
      body: detail.event.body,
      edited: false,
      truncated: detail.truncated,
    })
    setLoadingId(null)
  }, [loading.data, loadingId])

  // Dès qu'un vrai appel est arrivé, c'est lui qu'on essaie d'abord : il dit ce que le
  // service envoie vraiment, mieux qu'un exemple.
  const latest = list.find((row) => row.verdict !== 'unauthorized')
  useEffect(() => {
    if (touched.current || !latest) return
    touched.current = true
    setLoadingId(latest.id)
  }, [latest])

  const call = useMemo(() => ({ headers: parseHeaders(bench.headersText).headers, body: bench.body }), [bench.headersText, bench.body])
  const event = useMemo(() => benchEvent(call), [call])
  const local = useMemo(() => evaluateConditions(settings.conditions, event), [event, settings.conditions])

  // Essai serveur des réglages en cours sur l'appel du banc : le script et la marque de
  // session ne s'évaluent que là. Retardé pour ne pas partir à chaque frappe.
  const { mutate: runTest, data: tested, isPending: testPending, error: testError } = useTestWebhook(task.id)
  const testKey = JSON.stringify({ call, settings, prompt })
  useEffect(() => {
    const timer = setTimeout(() => {
      const input = JSON.parse(testKey) as { call: typeof call; settings: WebhookSettings; prompt: string }
      runTest(input)
    }, 350)
    return () => clearTimeout(timer)
  }, [testKey, runTest])

  const promptRef = useRef<HTMLTextAreaElement>(null)
  // Dernière position du curseur dans le prompt ; sans elle, on ajoute à la fin plutôt
  // qu'au tout début, où rien n'indique qu'on voulait écrire.
  const cursor = useRef<{ start: number; end: number } | null>(null)
  const remember = () => {
    const area = promptRef.current
    if (area) cursor.current = { start: area.selectionStart, end: area.selectionEnd }
  }
  const insert = (path: string) => {
    const area = promptRef.current
    const appended = cursor.current === null
    const marker = appended && prompt && !/\s$/.test(prompt) ? ` {{${path}}}` : `{{${path}}}`
    const at = cursor.current?.start ?? prompt.length
    const end = cursor.current?.end ?? prompt.length
    setPrompt(prompt.slice(0, at) + marker + prompt.slice(end))
    cursor.current = { start: at + marker.length, end: at + marker.length }
    requestAnimationFrame(() => {
      area?.focus()
      area?.setSelectionRange(at + marker.length, at + marker.length)
    })
  }
  const filterOn = (path: string, value: unknown) => {
    if (settings.conditions.rules.length >= MAX_AUTOMATION_RULES) return
    const primitive = value === null || typeof value !== 'object'
    const rule: AutomationRule = primitive && value !== null && value !== undefined
      ? { path, op: 'equals', value: valueText(value) }
      : { path, op: 'exists', value: '' }
    patch({ conditions: { ...settings.conditions, rules: [...settings.conditions.rules, rule] } })
  }

  const save = () => {
    const pending: Promise<unknown>[] = []
    if (settingsDirty) pending.push(updateHook.mutateAsync(settings))
    if (sessionDirty) pending.push(updateTask.mutateAsync({ id: task.id, ...session }))
    void Promise.all(pending).then(() => setBaseline({ settings, session }))
  }
  const saving = updateHook.isPending || updateTask.isPending
  const saveError = updateHook.error ?? updateTask.error
  const promptValid = prompt.trim() !== ''

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cx('flex shrink-0 items-center gap-2 border-b border-line px-3 py-3 sm:gap-3 md:px-6', sidebarHidden && 'md:pl-14')}>
        <MobileNavigationButton />
        <Link to={`/p/${task.projectId}/schedules`} className="grid size-9 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-surface-high hover:text-ink" aria-label={t('automation.back')} title={t('automation.back')}>
          <ArrowLeft size={17} />
        </Link>
        <Webhook size={19} className="hidden shrink-0 text-ink-faint sm:block" />
        <div className="min-w-0 flex-1">
          <NameField task={task} />
          <p className="truncate text-xs text-ink-faint">
            {project?.name}
            {webhook.template ? ` · ${t(TEMPLATE_LABELS[webhook.template].title)}` : ''}
          </p>
        </div>
        <span className="hidden sm:contents">
          <Badge tone={task.enabled ? 'positive' : 'neutral'}>{t(task.enabled ? 'automation.state.active' : 'automation.state.paused')}</Badge>
        </span>
        {/* Au téléphone, le geste se réduit à son icône : le nom a besoin de la largeur. */}
        <Button
          size="sm"
          variant="ghost"
          icon={task.enabled ? <Pause size={14} /> : <Play size={14} />}
          disabled={updateTask.isPending}
          aria-label={t(task.enabled ? 'schedule.action.pause' : 'schedule.action.resume')}
          onClick={() => updateTask.mutate({ id: task.id, enabled: !task.enabled })}
        >
          <span className="hidden sm:inline">{t(task.enabled ? 'schedule.action.pause' : 'schedule.action.resume')}</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          {webhook.trippedAt ? (
            <Banner tone="caution">{t('automation.tripped', { max: webhook.maxRunsPerHour, date: new Date(webhook.trippedAt).toLocaleString() })}</Banner>
          ) : null}

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
            <div className="flex min-w-0 flex-col gap-8">
              <Step number={1} title={t('automation.step.connect')} description={t('automation.step.connectHint')}>
                <AddressCard task={task} webhook={webhook} settings={settings} onChange={patch} />
              </Step>

              <Step number={2} title={t('automation.step.trigger')} description={t('automation.step.triggerHint')}>
                <ConditionsCard
                  conditions={settings.conditions}
                  results={local.results}
                  onChange={(conditions) => patch({ conditions })}
                />
                <ScriptCard script={settings.script} onChange={(script) => patch({ script })} />
              </Step>

              <Step number={3} title={t('automation.step.run')} description={t('automation.step.runHint')}>
                <SessionCard project={project} session={session} onChange={patchSession} />
                <Card>
                  <CardHeader icon={<Code2 size={16} />} title={t('automation.prompt.title')} description={t('automation.prompt.description')} />
                  <CardBody className="flex flex-col gap-3">
                    <textarea
                      ref={promptRef}
                      rows={9}
                      value={prompt}
                      aria-label={t('automation.prompt.title')}
                      onChange={(change) => { setPrompt(change.target.value); remember() }}
                      onSelect={remember}
                      className="rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[0.8125rem] text-ink outline-none transition-colors hover:border-line-strong focus:border-accent"
                    />
                    {!promptValid ? <Banner>{t('automation.prompt.required')}</Banner> : null}
                  </CardBody>
                </Card>
              </Step>

              <Step number={4} title={t('automation.step.guards')} description={t('automation.step.guardsHint')}>
                <GuardsCard settings={settings} onChange={patch} />
              </Step>
            </div>

            {/* Le banc reste à l'écran pendant qu'on fait défiler la configuration : c'est
                lui qui dit ce que chaque réglage change. */}
            <aside className="min-w-0 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-var(--header-height)-3rem)] lg:self-start lg:overflow-y-auto">
              <TestBench
                taskId={task.id}
                projectId={task.projectId}
                template={webhook.template}
                deliveries={list}
                deliveriesLoading={deliveries.isPending}
                call={bench}
                onCall={(next) => { touched.current = true; setBench(next) }}
                onLoadSample={loadSample}
                onLoadDelivery={loadDelivery}
                loadingDelivery={loadingId !== null}
                event={event}
                result={tested}
                pending={testPending}
                error={testError}
                hasScript={settings.script.trim() !== ''}
                onFilter={filterOn}
                onInsert={insert}
              />
            </aside>
          </div>
        </div>
      </div>

      {dirty ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-4 py-2.5 pb-safe md:px-6">
          {saveError ? <span className="mr-auto text-sm text-critical">{saveError.message}</span> : <span className="mr-auto text-sm text-ink-faint">{t('automation.unsaved')}</span>}
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setSettings(baseline.settings); setSession(baseline.session) }}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={saving || !promptValid} onClick={save}>
            {t('automation.save')}
          </Button>
        </footer>
      ) : null}
    </div>
  )
}

/**
 * Une étape de la page, dans l'ordre où l'on configure : brancher, déclencher, lancer,
 * protéger. Numérotée parce que c'en est une suite, pas pour décorer.
 */
function Step({ number, title, description, children }: { number: number; title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={title}>
      <header className="flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line-strong text-xs font-semibold text-ink-soft tabular-nums">
          {number}
        </span>
        <div className="min-w-0">
          <h2 className="text-[0.9375rem] leading-7 font-semibold text-ink">{title}</h2>
          <p className="text-sm text-ink-faint">{description}</p>
        </div>
      </header>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  )
}

/** Le nom, modifiable sur place : un clic, Entrée pour garder, Échap pour annuler. */
function NameField({ task }: { task: ScheduledTaskDto }) {
  const t = useTranslate()
  const update = useUpdateSchedule()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(task.name)
  const commit = () => {
    const next = value.trim()
    setEditing(false)
    if (next && next !== task.name) update.mutate({ id: task.id, name: next })
    else setValue(task.name)
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        maxLength={MAX_SCHEDULE_NAME_CHARS}
        aria-label={t('automation.name.label')}
        onChange={(change) => setValue(change.target.value)}
        onBlur={commit}
        onKeyDown={(key) => {
          if (key.key === 'Enter') commit()
          if (key.key === 'Escape') { setValue(task.name); setEditing(false) }
        }}
        className="w-full rounded border border-accent bg-sunken px-1.5 text-base font-semibold text-ink outline-none"
      />
    )
  }
  return (
    <h1 className="min-w-0 text-base font-semibold">
      <button
        type="button"
        onClick={() => { setValue(task.name); setEditing(true) }}
        title={t('automation.name.edit')}
        className="group/name flex max-w-full items-center gap-1.5 rounded text-left"
      >
        <span className="truncate">{task.name}</span>
        <Pencil size={13} aria-hidden className="shrink-0 text-ink-faint opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100 pointer-coarse:opacity-100" />
      </button>
    </h1>
  )
}

/** CLI, modèle, effort, permissions, durée et file : la session qu'ouvre chaque appel retenu. */
function SessionCard({
  project,
  session,
  onChange,
}: {
  project: ProjectDto | undefined
  session: SessionDraft
  onChange: (change: Partial<SessionDraft>) => void
}) {
  const t = useTranslate()
  const { data: userSettings } = useUserSettings()
  const defaultsFor = (agent: AgentKind): AgentConfig =>
    project?.defaultConfig[agent] ?? userSettings?.agentDefaults[agent] ?? defaultConfigFor(agent)
  const { groups, catalogError } = useAgentSettings({ config: session.config, onConfigChange: (config) => onChange({ config }) })

  return (
    <Card>
      <CardHeader icon={<Bot size={16} />} title={t('automation.session.title')} description={t('automation.session.description')} />
      <CardBody className="flex flex-col gap-4">
        <Select
          label={t('draft.cli.legend')}
          value={session.agent}
          // Un autre CLI repart de ses défauts : une configuration ne se convertit pas.
          onChange={(agent) => onChange({ agent, config: defaultsFor(agent) })}
          options={agentKindSchema.options.map((value) => ({
            value,
            label: AGENT_LABELS[value],
            icon: <AgentIcon agent={value} size={16} />,
          }))}
        />
        {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
        {groups.map((group) => (
          <GroupField key={group.key} group={group} />
        ))}
        <Banner tone="info">{t('schedule.form.unattended')}</Banner>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('schedule.form.maxDuration')}
            hint={t('schedule.form.maxDurationHint')}
            type="number"
            min={MIN_SCHEDULE_DURATION_MINUTES}
            max={MAX_SCHEDULE_DURATION_MINUTES}
            value={String(session.maxDurationMinutes)}
            onChange={(change) => {
              const next = Number(change.target.value)
              if (Number.isInteger(next) && next >= MIN_SCHEDULE_DURATION_MINUTES && next <= MAX_SCHEDULE_DURATION_MINUTES) {
                onChange({ maxDurationMinutes: next })
              }
            }}
          />
          <Select
            label={t('schedule.form.overlap')}
            value={session.overlapPolicy}
            onChange={(overlapPolicy) => onChange({ overlapPolicy })}
            options={[
              { value: 'wait', label: t('schedule.form.overlap.wait'), hint: t('automation.form.overlap.waitHint') },
              { value: 'skip', label: t('schedule.form.overlap.skip'), hint: t('automation.form.overlap.skipHint') },
            ]}
          />
        </div>
        <DecisionSettingsField
          value={{ decisionsEnabled: session.decisionsEnabled, decisionMaxHours: session.decisionMaxHours }}
          onChange={(value) => onChange(value)}
        />
      </CardBody>
    </Card>
  )
}

// --- Adresse ----------------------------------------------------------------------------

function AddressCard({
  task,
  webhook,
  settings,
  onChange,
}: {
  task: ScheduledTaskDto
  webhook: WebhookAutomationDto
  settings: WebhookSettings
  onChange: (change: Partial<WebhookSettings>) => void
}) {
  const t = useTranslate()
  const url = absoluteHookUrl(webhook.url)
  const urlCopy = useCopy()
  const secretCopy = useCopy()
  const reveal = useRevealSecret(task.id)
  const rotate = useRotateWebhook(task.id)
  const [secret, setSecret] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const verification = settings.verification

  const setKind = (kind: WebhookVerification['kind']) => {
    if (kind === 'none') onChange({ verification: { kind } })
    else if (kind === 'token') onChange({ verification: { kind, header: verification.kind === 'none' ? 'x-webhook-token' : verification.header } })
    else onChange({ verification: { kind, header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=' } })
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-soft">{t('automation.address.url')}</span>
          <div className="flex items-center gap-1 rounded-md border border-line bg-sunken py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={url}>{url}</code>
            <IconButton size="sm" label={t(urlCopy.state === 'copied' ? 'common.copied' : 'automation.address.copy')} onClick={() => urlCopy.copy(url)}>
              {urlCopy.state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          </div>
        </div>

        <Select
          label={t('automation.address.verification')}
          value={verification.kind}
          onChange={setKind}
          options={[
            { value: 'hmac', label: t('automation.verification.hmac'), hint: t('automation.verification.hmacHint') },
            { value: 'token', label: t('automation.verification.token'), hint: t('automation.verification.tokenHint') },
            { value: 'none', label: t('automation.verification.none'), hint: t('automation.verification.noneHint') },
          ]}
        />
        {verification.kind === 'none' ? <Banner tone="caution">{t('automation.verification.noneWarning')}</Banner> : null}
        {verification.kind !== 'none' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('automation.verification.header')}
              value={verification.header}
              spellCheck={false}
              onChange={(change) => onChange({ verification: { ...verification, header: change.target.value.toLowerCase() } })}
            />
            {verification.kind === 'hmac' ? (
              <Field
                label={t('automation.verification.prefix')}
                value={verification.prefix}
                spellCheck={false}
                onChange={(change) => onChange({ verification: { ...verification, prefix: change.target.value } })}
              />
            ) : null}
          </div>
        ) : null}

        {verification.kind !== 'none' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-soft">{t('automation.address.secret')}</span>
            <div className="flex items-center gap-1 rounded-md border border-line bg-sunken py-1 pr-1 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{secret ?? '•'.repeat(32)}</code>
              {secret ? (
                <IconButton size="sm" label={t(secretCopy.state === 'copied' ? 'common.copied' : 'automation.address.copySecret')} onClick={() => secretCopy.copy(secret)}>
                  {secretCopy.state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
              ) : (
                <IconButton size="sm" label={t('automation.address.reveal')} disabled={reveal.isPending} onClick={() => reveal.mutate(undefined, { onSuccess: (data) => setSecret(data.secret) })}>
                  <Eye size={14} />
                </IconButton>
              )}
            </div>
          </div>
        ) : null}

        <p className="text-xs text-ink-faint">{t('automation.address.githubHelp')}</p>
        <div>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => setConfirming(true)}>
            {t('automation.address.rotate')}
          </Button>
        </div>
        {reveal.error ?? rotate.error ? <Banner>{(reveal.error ?? rotate.error)?.message}</Banner> : null}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('automation.address.rotateTitle')}
        confirmLabel={t('automation.address.rotateConfirm')}
        tone="critical"
        busy={rotate.isPending}
        onConfirm={() => rotate.mutate(undefined, { onSuccess: (data) => { setSecret(data.secret); setConfirming(false) } })}
      >
        <p>{t('automation.address.rotateBody')}</p>
      </ConfirmDialog>
    </Card>
  )
}

// --- Conditions -----------------------------------------------------------------------------

function ConditionsCard({
  conditions,
  results,
  onChange,
}: {
  conditions: WebhookSettings['conditions']
  results: RuleResult[] | null
  onChange: (conditions: WebhookSettings['conditions']) => void
}) {
  const t = useTranslate()
  return (
    <Card>
      <CardHeader icon={<ShieldCheck size={16} />} title={t('automation.conditions.title')} description={t('automation.conditions.description')} />
      <CardBody>
        <ConditionsEditor conditions={conditions} results={results ?? []} onChange={onChange} />
      </CardBody>
    </Card>
  )
}

// --- Script -------------------------------------------------------------------------------

/** Le script facultatif : son éditeur seulement, ce qu'il rend se lit dans le banc d'essai. */
function ScriptCard({ script, onChange }: { script: string; onChange: (script: string) => void }) {
  const t = useTranslate()
  const enabled = script.trim() !== ''
  return (
    <Card>
      <CardHeader
        icon={<Code2 size={16} />}
        title={t('automation.script.title')}
        description={t('automation.script.description')}
        actions={
          enabled ? (
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => onChange('')}>{t('automation.script.remove')}</Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onChange(t('automation.script.starter'))}>{t('automation.script.add')}</Button>
          )
        }
      />
      {enabled ? (
        <CardBody className="flex flex-col gap-2">
          <ScriptEditor value={script} onChange={onChange} label={t('automation.script.title')} />
          <p className="text-xs text-ink-faint">{t('automation.script.benchHint')}</p>
        </CardBody>
      ) : null}
    </Card>
  )
}

// --- Garde-fous ---------------------------------------------------------------------------

function GuardsCard({ settings, onChange }: { settings: WebhookSettings; onChange: (change: Partial<WebhookSettings>) => void }) {
  const t = useTranslate()
  const runs = settings.maxRunsPerHour
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <Field
          label={t('automation.guards.subject')}
          hint={t('automation.guards.subjectHint')}
          value={settings.subjectPath}
          placeholder="payload.issue.number"
          spellCheck={false}
          onChange={(change) => onChange({ subjectPath: change.target.value })}
        />
        <Field
          label={t('automation.guards.marker')}
          hint={t('automation.guards.markerHint')}
          value={settings.markerPaths}
          placeholder="payload.comment.body"
          spellCheck={false}
          onChange={(change) => onChange({ markerPaths: change.target.value })}
        />
        <Field
          label={t('automation.guards.delivery')}
          hint={t('automation.guards.deliveryHint')}
          value={settings.deliveryHeader}
          placeholder="x-github-delivery"
          spellCheck={false}
          onChange={(change) => onChange({ deliveryHeader: change.target.value.toLowerCase() })}
        />
        <Field
          label={t('automation.guards.rate')}
          hint={t('automation.guards.rateHint')}
          type="number"
          min={1}
          max={MAX_AUTOMATION_RUNS_PER_HOUR}
          value={String(runs)}
          onChange={(change) => {
            const next = Number(change.target.value)
            if (Number.isInteger(next) && next >= 1 && next <= MAX_AUTOMATION_RUNS_PER_HOUR) onChange({ maxRunsPerHour: next })
          }}
        />
      </CardBody>
    </Card>
  )
}
