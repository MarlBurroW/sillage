import * as Dialog from '@radix-ui/react-dialog'
import { ExternalLink, EyeOff, Lock, RefreshCw, Unlink, X } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  DEFAULT_BOARD_LINK_SETTINGS,
  MAX_BOARD_INSTRUCTIONS_CHARS,
  MAX_BOARD_SESSIONS_PER_HOUR,
  MAX_BOARD_SIGNATURE_CHARS,
  agentKindSchema,
  defaultConfigFor,
  githubRepoSchema,
  type BoardLinkSettings,
  type BoardLinkStateDto,
  type ProjectDto,
} from '@sillage/protocol'
import { useResetHiddenIssues, useSaveBoardLink, useSyncBoard, useUnlinkBoard } from '../../lib/board-link'
import { translateError, useTranslate } from '../../lib/i18n'
import { formatAgo } from '../../lib/loops'
import { useUserSettings } from '../../lib/user-settings'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useAgentSettings } from '../chat/agent-settings'
import { GroupField } from '../schedule/GroupField'
import { Banner, Button, ChoiceList, ConfirmDialog, Field, IconButton, Select, Switch, cx } from '../ui'
import { GitHubMark } from './GitHubMark'
import { DecisionSettingsField, decisionSettingsValid } from '../decisions/DecisionSettingsField'

/**
 * Relier le board aux issues d'un dépôt GitHub, ou régler la liaison.
 *
 * Le même formulaire sert aux deux : relier n'est que le premier enregistrement des
 * réglages. Ce qui n'existe qu'une fois relié (état de la synchronisation, issues
 * masquées, délier) se range au-dessus et en dessous, sans changer l'ordre des champs.
 */
export function BoardLinkDialog({
  projectId,
  project,
  state,
  canEdit,
  open,
  onClose,
}: {
  projectId: string
  project: ProjectDto
  state: BoardLinkStateDto
  canEdit: boolean
  open: boolean
  onClose: () => void
}) {
  const t = useTranslate()
  const { link } = state
  const initial = (): BoardLinkSettings =>
    link
      ? {
          repo: link.repo,
          labelFilter: link.labelFilter,
          closedDays: link.closedDays,
          newCards: link.newCards,
          progressLabel: link.progressLabel,
          reviewLabel: link.reviewLabel,
          onIssue: link.onIssue,
          issueInstructions: link.issueInstructions,
          onComment: link.onComment,
          commentInstructions: link.commentInstructions,
          commentDelivery: link.commentDelivery,
          replyStyle: link.replyStyle,
          identity: link.identity,
          signature: link.signature,
          sessionAgent: link.sessionAgent,
          sessionConfig: link.sessionConfig,
          workspace: link.workspace,
          maxSessionsPerHour: link.maxSessionsPerHour,
          decisionsEnabled: link.decisionsEnabled,
          decisionMaxHours: link.decisionMaxHours,
        }
      : { repo: state.suggestedRepo ?? '', ...DEFAULT_BOARD_LINK_SETTINGS }
  const [settings, setSettings] = useState<BoardLinkSettings>(initial)
  // Rouvrir le dialogue repart de ce que le serveur sait, pas d'une saisie abandonnée.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setSettings(initial()) }, [open, link?.repo])
  const [tab, setTab] = useState<'sync' | 'maintenance'>('sync')
  const [unlinking, setUnlinking] = useState(false)
  const [keepCards, setKeepCards] = useState(false)

  const save = useSaveBoardLink(projectId)
  const unlink = useUnlinkBoard(projectId)
  const sync = useSyncBoard(projectId)
  const resetHidden = useResetHiddenIssues(projectId)
  const set = <K extends keyof BoardLinkSettings>(key: K, value: BoardLinkSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }))

  const repoValid = githubRepoSchema.safeParse(settings.repo).success
  const capValid =
    Number.isInteger(settings.maxSessionsPerHour) &&
    settings.maxSessionsPerHour >= 1 &&
    settings.maxSessionsPerHour <= MAX_BOARD_SESSIONS_PER_HOUR &&
    decisionSettingsValid(settings)
  const readOnly = !canEdit || (!link && !state.hasCredential)
  const dirty = JSON.stringify(settings) !== JSON.stringify(initial())
  const submit = () => {
    if (readOnly || !repoValid || !capValid || save.isPending) return
    save.mutate(settings, { onSuccess: () => { if (!link) onClose() } })
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[95dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(640px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center gap-3 border-b border-line px-5 py-4">
            <GitHubMark size={20} />
            <Dialog.Title className="min-w-0 flex-1 text-lg font-semibold">
              {t(link ? 'board.github.dialog.linkedTitle' : 'board.github.dialog.title')}
            </Dialog.Title>
            <IconButton label={t('board.panel.close')} onClick={onClose}><X size={18} /></IconButton>
          </header>
          <nav role="tablist" aria-label={t('board.github.dialog.sections')} className="flex shrink-0 gap-5 border-b border-line px-5">
            {(['sync', 'maintenance'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cx(
                  'flex min-h-12 items-center gap-2 border-b-2 text-sm font-medium transition-colors',
                  tab === value ? 'border-accent text-accent' : 'border-transparent text-ink-faint hover:text-ink',
                )}
              >
                {t(value === 'sync' ? 'board.github.tab.sync' : 'board.github.tab.maintenance')}
                {value === 'maintenance' && (settings.onIssue || settings.onComment) ? (
                  <span className="size-1.5 rounded-full bg-positive" aria-label={t('board.github.maintenance.active')} />
                ) : null}
              </button>
            ))}
          </nav>

          <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); submit() }}>
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
              {tab === 'maintenance' ? (
                <MaintenanceSettings settings={settings} set={set} project={project} readOnly={readOnly} />
              ) : <>
              {link ? (
                <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 font-mono text-sm font-medium text-ink hover:text-accent">
                      <span className="truncate">{link.repo}</span>
                      <ExternalLink size={13} className="shrink-0" />
                    </a>
                    <div className="flex-1" />
                    <Button type="button" size="sm" variant="secondary" disabled={sync.isPending || link.syncing}
                      icon={<RefreshCw size={14} className={cx((sync.isPending || link.syncing) && 'animate-spin')} />}
                      onClick={() => sync.mutate()}>
                      {t('board.github.syncNow')}
                    </Button>
                  </div>
                  <p className="text-xs text-ink-faint" role="status">
                    {link.syncing || sync.isPending
                      ? t('board.github.syncing')
                      : link.lastSyncedAt
                        ? t('board.github.syncedAgo', { ago: formatAgo(Date.now() - link.lastSyncedAt) })
                        : t('board.github.neverSynced')}
                    {' · '}
                    {t('board.github.actingAs', { name: link.userName })}
                  </p>
                  {link.lastError ? <Banner tone="caution">{translateError(link.lastError, '')}</Banner> : null}
                  {sync.isError ? <Banner>{sync.error.message}</Banner> : null}
                  {link.hiddenCount > 0 ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                      <EyeOff size={13} />
                      <span className="flex-1">{t('board.github.hidden', { count: link.hiddenCount })}</span>
                      {canEdit ? (
                        <Button type="button" size="sm" variant="ghost" disabled={resetHidden.isPending} onClick={() => resetHidden.mutate()}>
                          {t('board.github.hidden.reset')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm leading-relaxed text-ink-soft">{t('board.github.dialog.intro')}</p>
              )}

              {!link && !state.hasCredential ? (
                <Banner tone="caution">
                  {t('board.github.noCredential')}{' '}
                  <Link to="/settings/git" className="font-medium underline">{t('board.github.noCredential.link')}</Link>
                </Banner>
              ) : null}
              {!canEdit ? <Banner tone="info">{t('board.github.ownerOnly')}</Banner> : null}

              {/* `min-w-0` : un fieldset prend par défaut la largeur de son contenu, et le
                  dialogue débordait de l'écran du téléphone. */}
              <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-5">
                <Field
                  label={t('board.github.repo')}
                  value={settings.repo}
                  readOnly={Boolean(link)}
                  icon={link ? <Lock size={14} /> : <GitHubMark size={14} />}
                  placeholder="owner/name"
                  spellCheck={false}
                  onChange={(event) => set('repo', event.target.value.trim())}
                  hint={t(link ? 'board.github.repo.locked' : state.suggestedRepo && settings.repo === state.suggestedRepo ? 'board.github.repo.fromOrigin' : 'board.github.repo.hint')}
                  error={settings.repo && !repoValid ? t('board.github.repo.invalid') : undefined}
                />

                <ChoiceList
                  label={t('board.github.newCards')}
                  value={settings.newCards}
                  onChange={(value) => set('newCards', value)}
                  options={[
                    { value: 'local', label: t('board.github.newCards.local'), hint: t('board.github.newCards.local.hint') },
                    { value: 'github', label: t('board.github.newCards.github'), hint: t('board.github.newCards.github.hint') },
                  ]}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t('board.github.labelFilter')}
                    value={settings.labelFilter}
                    maxLength={50}
                    placeholder={t('board.github.labelFilter.placeholder')}
                    onChange={(event) => set('labelFilter', event.target.value)}
                    hint={t('board.github.labelFilter.hint')}
                  />
                  <Field
                    label={t('board.github.closedDays')}
                    type="number"
                    min={0}
                    max={365}
                    value={settings.closedDays}
                    onChange={(event) => set('closedDays', Math.max(0, Math.min(365, Number(event.target.value) || 0)))}
                    hint={t('board.github.closedDays.hint')}
                  />
                </div>

                <details className="group rounded-xl border border-line">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-soft">{t('board.github.advanced')}</summary>
                  <div className="flex flex-col gap-4 border-t border-line p-4">
                    <p className="text-xs leading-relaxed text-ink-faint">{t('board.github.columns.hint')}</p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label={t('board.github.progressLabel')} value={settings.progressLabel} maxLength={50} onChange={(event) => set('progressLabel', event.target.value)} />
                      <Field label={t('board.github.reviewLabel')} value={settings.reviewLabel} maxLength={50} onChange={(event) => set('reviewLabel', event.target.value)} />
                    </div>
                  </div>
                </details>
              </fieldset>

              </>}

              {save.isError ? <Banner>{save.error.message}</Banner> : null}

              {tab === 'sync' && link && canEdit ? (
                <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                  <p className="min-w-0 flex-1 text-xs text-ink-faint">{t('board.github.unlink.hint')}</p>
                  <Button type="button" size="sm" variant="danger" icon={<Unlink size={14} />} onClick={() => setUnlinking(true)}>
                    {t('board.github.unlink')}
                  </Button>
                </div>
              ) : null}
            </div>

            <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>{t(link ? 'board.panel.close' : 'board.card.cancel')}</Button>
              {canEdit ? (
                <Button type="submit" disabled={readOnly || !repoValid || !capValid || save.isPending || (Boolean(link) && !dirty)}>
                  {t(save.isPending ? (link ? 'board.card.saving' : 'board.github.linking') : link ? 'board.card.save' : 'board.github.link')}
                </Button>
              ) : null}
            </footer>
          </form>

          <ConfirmDialog
            open={unlinking}
            onOpenChange={setUnlinking}
            title={t('board.github.unlink.title', { repo: link?.repo ?? '' })}
            confirmLabel={t('board.github.unlink')}
            tone="critical"
            busy={unlink.isPending}
            onConfirm={() => unlink.mutate(keepCards, { onSuccess: () => { setUnlinking(false); onClose() } })}
          >
            <p>{t('board.github.unlink.body')}</p>
            <label className="flex items-start gap-2 text-sm text-ink-soft">
              <input type="checkbox" className="mt-1" checked={keepCards} onChange={(event) => setKeepCards(event.target.checked)} />
              <span>{t('board.github.unlink.keep')}</span>
            </label>
            {unlink.isError ? <p role="alert" className="text-critical">{unlink.error.message}</p> : null}
          </ConfirmDialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Les réglages de session qui comptent pour une maintenance : le modèle, l'effort et ce
 * que l'agent a le droit de faire. Le reste, propre à chaque CLI, se replie.
 */
const PRIMARY_SETTINGS = new Set(['model', 'effort', 'permission', 'approval', 'sandbox'])

type SetSetting = <K extends keyof BoardLinkSettings>(key: K, value: BoardLinkSettings[K]) => void

/**
 * Les sessions de maintenance : ce qui les ouvre, ce qu'elles font, comment elles
 * répondent, avec quels réglages. Rendu seulement sur son onglet : le sélecteur de modèle
 * sonde le CLI côté serveur, inutile tant qu'on ne regarde que la synchronisation.
 */
function MaintenanceSettings({
  settings,
  set,
  project,
  readOnly,
}: {
  settings: BoardLinkSettings
  set: SetSetting
  project: ProjectDto
  readOnly: boolean
}) {
  const t = useTranslate()
  const { data: userSettings } = useUserSettings()
  const agent = settings.sessionAgent
  // Même ordre que pour une conversation neuve : le préréglage du projet, puis les défauts
  // du compte. Tant que rien n'est retouché, le board suit ces réglages (null en base).
  const defaults = project.defaultConfig[agent] ?? userSettings?.agentDefaults[agent] ?? defaultConfigFor(agent)
  const config = settings.sessionConfig?.agent === agent ? settings.sessionConfig : defaults
  const { groups, catalogError } = useAgentSettings({ config, onConfigChange: (next) => set('sessionConfig', next), disabled: readOnly })

  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
      <p className="text-sm leading-relaxed text-ink-soft">{t('board.github.maintenance.intro')}</p>

      <Trigger
        title={t('board.github.onIssue')}
        hint={t('board.github.onIssue.hint')}
        checked={settings.onIssue}
        onCheckedChange={(value) => set('onIssue', value)}
        readOnly={readOnly}
      >
        <Instructions
          label={t('board.github.issueInstructions')}
          value={settings.issueInstructions}
          placeholder={t('board.github.issueInstructions.placeholder')}
          onChange={(value) => set('issueInstructions', value)}
        />
      </Trigger>

      <Trigger
        title={t('board.github.onComment')}
        hint={t('board.github.onComment.hint')}
        checked={settings.onComment}
        onCheckedChange={(value) => set('onComment', value)}
        readOnly={readOnly}
      >
        <Instructions
          label={t('board.github.commentInstructions')}
          value={settings.commentInstructions}
          placeholder={t('board.github.commentInstructions.placeholder')}
          onChange={(value) => set('commentInstructions', value)}
        />
        <Select
          label={t('board.github.commentDelivery')}
          value={settings.commentDelivery}
          onChange={(value) => set('commentDelivery', value)}
          options={[
            { value: 'queue', label: t('board.github.commentDelivery.queue') },
            { value: 'steer', label: t('board.github.commentDelivery.steer') },
          ]}
        />
      </Trigger>

      <Group title={t('board.github.replies')}>
        <Instructions
          label={t('board.github.replyStyle')}
          value={settings.replyStyle}
          placeholder={t('board.github.replyStyle.placeholder')}
          onChange={(value) => set('replyStyle', value)}
        />
        <ChoiceList
          label={t('board.github.identity')}
          value={settings.identity}
          onChange={(value) => set('identity', value)}
          options={[
            { value: 'developer', label: t('board.github.identity.developer'), hint: t('board.github.identity.developer.hint') },
            { value: 'ai', label: t('board.github.identity.ai'), hint: t('board.github.identity.ai.hint') },
          ]}
        />
        {settings.identity === 'ai' ? (
          <Field
            label={t('board.github.signature')}
            value={settings.signature}
            maxLength={MAX_BOARD_SIGNATURE_CHARS}
            onChange={(event) => set('signature', event.target.value)}
            hint={t('board.github.signature.hint')}
          />
        ) : null}
      </Group>

      <Group title={t('board.github.session')}>
        <Select
          label={t('draft.cli.legend')}
          value={agent}
          onChange={(value) => {
            set('sessionAgent', value)
            // Les réglages d'un autre CLI ne se convertissent pas : on repart des siens.
            set('sessionConfig', null)
          }}
          options={agentKindSchema.options.map((value) => ({ value, label: AGENT_LABELS[value], icon: <AgentIcon agent={value} size={16} /> }))}
        />
        {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
        {groups.filter((group) => PRIMARY_SETTINGS.has(group.key)).map((group) => <GroupField key={group.key} group={group} />)}
        {groups.some((group) => !PRIMARY_SETTINGS.has(group.key)) ? (
          <details className="rounded-xl border border-line">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-soft">{t('board.github.session.more')}</summary>
            <div className="flex flex-col gap-4 border-t border-line p-4">
              {groups.filter((group) => !PRIMARY_SETTINGS.has(group.key)).map((group) => <GroupField key={group.key} group={group} />)}
            </div>
          </details>
        ) : null}
        <ChoiceList
          label={t('board.github.workspace')}
          value={settings.workspace}
          onChange={(value) => set('workspace', value)}
          options={[
            { value: 'worktree', label: t('board.github.workspace.worktree'), hint: t('board.github.workspace.worktree.hint') },
            { value: 'root', label: t('board.github.workspace.root'), hint: t('board.github.workspace.root.hint') },
          ]}
        />
        <Field
          label={t('board.github.maxSessions')}
          type="number"
          min={1}
          max={MAX_BOARD_SESSIONS_PER_HOUR}
          value={settings.maxSessionsPerHour}
          onChange={(event) => set('maxSessionsPerHour', Math.trunc(Number(event.target.value)))}
          hint={t('board.github.maxSessions.hint')}
          error={settings.maxSessionsPerHour >= 1 && settings.maxSessionsPerHour <= MAX_BOARD_SESSIONS_PER_HOUR ? undefined : t('board.github.maxSessions.invalid', { max: MAX_BOARD_SESSIONS_PER_HOUR })}
        />
        <DecisionSettingsField
          value={{ decisionsEnabled: settings.decisionsEnabled, decisionMaxHours: settings.decisionMaxHours }}
          disabled={readOnly}
          onChange={(value) => {
            set('decisionsEnabled', value.decisionsEnabled)
            set('decisionMaxHours', value.decisionMaxHours)
          }}
        />
      </Group>
    </fieldset>
  )
}

/** Un déclencheur : son interrupteur, et ce qu'il fait quand il est allumé. */
function Trigger({
  title,
  hint,
  checked,
  onCheckedChange,
  readOnly,
  children,
}: {
  title: string
  hint: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  readOnly: boolean
  children: ReactNode
}) {
  return (
    <section className={cx('flex flex-col gap-4 rounded-xl border p-4 transition-colors', checked ? 'border-accent/50' : 'border-line')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="text-xs leading-relaxed text-ink-faint">{hint}</p>
        </div>
        <Switch checked={checked} label={title} disabled={readOnly} onCheckedChange={onCheckedChange} />
      </div>
      {/* Toujours modifiable : on prépare l'instruction avant d'allumer. */}
      {children}
    </section>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Instructions({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-soft">{label}</label>
      <textarea
        id={id}
        value={value}
        rows={4}
        maxLength={MAX_BOARD_INSTRUCTIONS_CHARS}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
      />
    </div>
  )
}
