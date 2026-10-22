import { MoreHorizontal, Pencil, Plug, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { NavLink } from 'react-router-dom'
import type { McpServer, McpTransport } from '@sillage/protocol'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Select,
  Switch,
  cx,
} from '../components/ui'
import { ListHeading, SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import {
  describeTransport,
  useCreateMcpServer,
  useDeleteMcpServer,
  useMcpServers,
  useUpdateMcpServer,
  type McpServerInput,
} from '../lib/mcp'
import { useCurrentUser } from '../lib/session'

/**
 * MCP server registry.
 *
 * Arguments, environment variables and headers use individually added rows instead of a text
 * block to parse. Text blocks pasted well from documentation but required remembering a format,
 * and malformed lines silently disappeared.
 */

/**
 * Each row has its own ID.
 *
 * Index keys would shift focus and subsequent field state when deleting a middle row.
 */
interface Row {
  id: string
  key: string
  value: string
}

interface FormState {
  name: string
  type: McpTransport['type']
  command: string
  args: Row[]
  env: Row[]
  url: string
  headers: Row[]
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'stdio',
  command: '',
  args: [],
  env: [],
  url: '',
  headers: [],
}

/** Shared row-field styling, with each field retaining its own width. */
const ROW_INPUT =
  'tap-target min-w-0 rounded-md border border-line bg-sunken px-3 font-mono text-sm text-ink ' +
  'outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent'

let nextRowId = 0
const emptyRow = (): Row => ({ id: `row-${nextRowId++}`, key: '', value: '' })

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

/**
 * Ignore unnamed rows instead of rejecting them: newly added rows are initially empty, so
 * failing submission would hinder more than help. Duplicate names use the last row, matching
 * the receiving CLI's table behavior.
 */
const toRecord = (rows: Row[]): Record<string, string> =>
  Object.fromEntries(
    rows.filter((row) => row.key.trim().length > 0).map((row) => [row.key.trim(), row.value]),
  )

const fromRecord = (pairs: Record<string, string>): Row[] =>
  Object.entries(pairs).map(([key, value]) => ({ ...emptyRow(), key, value }))

/** Arguments have no names: only their value is entered in `value`. */
const toValues = (rows: Row[]): string[] =>
  rows.map((row) => row.value.trim()).filter((value) => value.length > 0)

const fromValues = (values: string[]): Row[] =>
  values.map((value) => ({ ...emptyRow(), value }))

const toTransport = (form: FormState): McpTransport =>
  form.type === 'stdio'
    ? {
        type: 'stdio',
        command: form.command.trim(),
        args: toValues(form.args),
        env: toRecord(form.env),
      }
    : {
        type: form.type,
        url: form.url.trim(),
        headers: toRecord(form.headers),
      }

const toForm = (server: McpServer): FormState => ({
  ...EMPTY_FORM,
  name: server.name,
  type: server.transport.type,
  ...(server.transport.type === 'stdio'
    ? {
        command: server.transport.command,
        args: fromValues(server.transport.args),
        env: fromRecord(server.transport.env),
      }
    : {
        url: server.transport.url,
        headers: fromRecord(server.transport.headers),
      }),
})

export function McpSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data } = useMcpServers()
  const servers = data?.servers ?? []

  const createServer = useCreateMcpServer()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const openForm = () => {
    setForm(EMPTY_FORM)
    createServer.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createServer.mutate(
      { name: form.name.trim(), enabled: true, transport: toTransport(form) },
      { onSuccess: () => setAdding(false) },
    )
  }

  const addButton = isAdmin ? (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={openForm}>
      {t('mcp.create.open')}
    </Button>
  ) : null

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('mcp.section.title')} description={t('mcp.section.description')} />

      <Banner tone="info">{t('mcp.banner')}</Banner>
      {/*
       * Two meanings of MCP: here, servers Sillage provides to agents; under “API and MCP”, the
       * server Sillage exposes. Explain this so users do not search here for external Codex
       * connections.
       */}
      <p className="text-sm text-ink-faint">
        {t('mcp.ownServer')}{' '}
        <NavLink to="/settings/api" className="text-accent hover:underline">
          {t('mcp.ownServer.link')}
        </NavLink>
      </p>
      {isAdmin ? null : <Banner>{t('mcp.readonly')}</Banner>}

      <section className="flex flex-col gap-2">
        {/* Empty list: the empty state carries the button, not the header. */}
        <ListHeading
          title={t('mcp.existing.title')}
          count={servers.length}
          action={servers.length > 0 ? addButton : null}
        />

        {adding ? (
          <Card>
            <CardHeader title={t('mcp.create.title')} icon={<Plus size={16} />} />
            <CardBody>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <TransportFields form={form} onChange={setForm} autoFocus />
                {errorOf(createServer.error) ? <Banner>{errorOf(createServer.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={createServer.isPending}>
                    {createServer.isPending ? t('mcp.create.pending') : t('mcp.create.action')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {servers.length === 0 ? (
          adding ? null : (
            <EmptyState
              icon={<Plug size={22} />}
              title={t('mcp.empty.title')}
              description={t('mcp.empty.description')}
              action={addButton}
            />
          )
        ) : (
          servers.map((server) => (
            <ServerCard key={server.id} server={server} canEdit={isAdmin} />
          ))
        )}
      </section>
    </div>
  )
}

/** Shared by creation and editing: both edit the same data. */
function TransportFields({
  form,
  onChange,
  autoFocus = false,
}: {
  form: FormState
  onChange: (form: FormState) => void
  /** Focus the first field of the newly opened form. */
  autoFocus?: boolean
}) {
  const t = useTranslate()

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('mcp.name.label')}
          hint={t('mcp.name.hint')}
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
          pattern="[a-zA-Z0-9_-]+"
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus={autoFocus}
          required
        />
        <Select
          label={t('mcp.transport.label')}
          value={form.type}
          onChange={(type) => onChange({ ...form, type })}
          options={[
            { value: 'stdio' as const, label: t('mcp.transport.stdio') },
            { value: 'http' as const, label: t('mcp.transport.http') },
            { value: 'sse' as const, label: t('mcp.transport.sse') },
          ]}
        />
      </div>

      {form.type === 'stdio' ? (
        <>
          <Field
            label={t('mcp.command.label')}
            value={form.command}
            onChange={(event) => onChange({ ...form, command: event.target.value })}
            autoCapitalize="none"
            autoCorrect="off"
            required
          />
          <RowList
            label={t('mcp.args.label')}
            addLabel={t('mcp.args.add')}
            valuePlaceholder={t('mcp.args.placeholder')}
            rows={form.args}
            onChange={(args) => onChange({ ...form, args })}
          />
          <RowList
            label={t('mcp.env.label')}
            hint={t('mcp.env.hint')}
            addLabel={t('mcp.env.add')}
            keyPlaceholder={t('mcp.env.name')}
            valuePlaceholder={t('mcp.value.placeholder')}
            rows={form.env}
            onChange={(env) => onChange({ ...form, env })}
          />
        </>
      ) : (
        <>
          <Field
            label={t('mcp.url.label')}
            type="url"
            value={form.url}
            onChange={(event) => onChange({ ...form, url: event.target.value })}
            autoCapitalize="none"
            autoCorrect="off"
            required
          />
          <RowList
            label={t('mcp.headers.label')}
            hint={t('mcp.headers.hint')}
            addLabel={t('mcp.headers.add')}
            keyPlaceholder={t('mcp.headers.name')}
            valuePlaceholder={t('mcp.value.placeholder')}
            rows={form.headers}
            onChange={(headers) => onChange({ ...form, headers })}
          />
        </>
      )}

      {/*
       * Inside the form, not the page header: choosing cleartext versus a secret happens while
       * entering a value.
       */}
      <Banner tone="caution">{t('mcp.secrets')}</Banner>
    </>
  )
}

/**
 * Rows added on demand.
 *
 * Without `keyPlaceholder`, rows contain only values, as for ordered arguments rather than a
 * map. One component handles both to avoid duplicating add/remove behavior.
 */
function RowList({
  label,
  hint,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  onChange,
}: {
  label: string
  hint?: string
  addLabel: string
  keyPlaceholder?: string
  valuePlaceholder: string
  rows: Row[]
  onChange: (rows: Row[]) => void
}) {
  const t = useTranslate()

  const patch = (id: string, part: Partial<Row>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...part } : row)))

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-soft">{label}</span>

      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          {keyPlaceholder === undefined ? null : (
            <input
              value={row.key}
              onChange={(event) => patch(row.id, { key: event.target.value })}
              placeholder={keyPlaceholder}
              aria-label={keyPlaceholder}
              autoCapitalize="none"
              autoCorrect="off"
              className={cx(ROW_INPUT, 'flex-1')}
            />
          )}
          <input
            value={row.value}
            onChange={(event) => patch(row.id, { value: event.target.value })}
            placeholder={valuePlaceholder}
            aria-label={valuePlaceholder}
            autoCapitalize="none"
            autoCorrect="off"
            className={cx(ROW_INPUT, 'flex-[2]')}
          />
          <IconButton
            label={t('mcp.row.remove')}
            size="sm"
            onClick={() => onChange(rows.filter((other) => other.id !== row.id))}
          >
            <X size={15} />
          </IconButton>
        </div>
      ))}

      <Button
        type="button"
        size="sm"
        variant="ghost"
        icon={<Plus size={14} />}
        className="self-start"
        onClick={() => onChange([...rows, emptyRow()])}
      >
        {addLabel}
      </Button>

      {hint ? <p className="text-xs text-ink-faint">{hint}</p> : null}
    </div>
  )
}

function ServerCard({ server, canEdit }: { server: McpServer; canEdit: boolean }) {
  const t = useTranslate()
  const updateServer = useUpdateMcpServer()
  const deleteServer = useDeleteMcpServer()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<FormState>(() => toForm(server))
  const [confirming, setConfirming] = useState(false)

  const startEditing = () => {
    // Restart from the saved record, not the last draft: reopening after cancellation
    // must show saved values, not abandoned edits.
    setForm(toForm(server))
    setEditing(true)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const patch: Partial<McpServerInput> = {
      name: form.name.trim(),
      transport: toTransport(form),
    }
    updateServer.mutate({ id: server.id, ...patch }, { onSuccess: () => setEditing(false) })
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{server.name}</span>
              <Badge>{server.transport.type}</Badge>
              {/*
               * The switch already shows state to users who can change it; retain badges for
               * others only when there is something to report.
               */}
              {!server.enabled ? <Badge>{t('mcp.state.disabled')}</Badge> : null}
            </div>
            <p className="truncate font-mono text-xs text-ink-faint">
              {describeTransport(server.transport)}
            </p>
          </div>

          {canEdit ? (
            <div className="flex shrink-0 items-center gap-1">
              <Switch
                checked={server.enabled}
                disabled={updateServer.isPending}
                label={t('mcp.toggle.label', { name: server.name })}
                onCheckedChange={(enabled) => updateServer.mutate({ id: server.id, enabled })}
              />
              {/*
               * On touch screens, no room for another button beside the command: move “Edit”
               * into the menu. The open form has its own “Cancel”, so do not duplicate it.
               */}
              {editing ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="hidden md:inline-flex"
                  onClick={startEditing}
                >
                  {t('mcp.action.edit')}
                </Button>
              )}
              <Menu
                trigger={
                  <IconButton label={t('mcp.action.more')} size="sm">
                    <MoreHorizontal size={16} />
                  </IconButton>
                }
              >
                <div className="md:hidden">
                  <MenuItem
                    icon={<Pencil size={15} />}
                    onSelect={() => (editing ? setEditing(false) : startEditing())}
                  >
                    {t(editing ? 'mcp.action.cancel' : 'mcp.action.edit')}
                  </MenuItem>
                  <MenuSeparator />
                </div>
                <MenuItem icon={<Trash2 size={15} />} tone="critical" onSelect={() => setConfirming(true)}>
                  {t('mcp.action.delete')}
                </MenuItem>
              </Menu>
            </div>
          ) : null}
        </div>

        {errorOf(updateServer.error) && !editing ? (
          <Banner>{errorOf(updateServer.error)}</Banner>
        ) : null}

        {editing ? (
          <form onSubmit={save} className="flex flex-col gap-4 rounded-md border border-line bg-sunken p-3">
            <TransportFields form={form} onChange={setForm} />
            {errorOf(updateServer.error) ? <Banner>{errorOf(updateServer.error)}</Banner> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={updateServer.isPending}>
                {updateServer.isPending ? t('mcp.action.saving') : t('mcp.action.save')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : null}

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('mcp.delete.title', { name: server.name })}
          confirmLabel={t('mcp.delete.confirm')}
          tone="critical"
          busy={deleteServer.isPending}
          onConfirm={() => deleteServer.mutate(server.id)}
        >
          {t('mcp.delete.body')}
        </ConfirmDialog>
      </CardBody>
    </Card>
  )
}
