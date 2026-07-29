import { Plug, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
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
  Select,
  cx,
} from '../components/ui'
import { SectionHeader } from './SettingsPage'
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
 * Registre des serveurs MCP.
 *
 * Les arguments, les variables d'environnement et les en-têtes se saisissent en lignes
 * ajoutées une à une, et non dans un bloc de texte à découper. Le bloc de texte se
 * collait bien depuis une documentation, mais il demandait de tenir un format dans sa
 * tête, et une ligne mal séparée disparaissait sans rien dire.
 */

/**
 * Une ligne de liste porte un identifiant propre.
 *
 * Sans lui, la clé de rendu serait l'indice, et supprimer une ligne du milieu ferait
 * glisser le focus et l'état des champs suivants d'un cran.
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

/** Habillage commun aux champs d'une ligne, la largeur restant propre à chacun. */
const ROW_INPUT =
  'tap-target min-w-0 rounded-md border border-line bg-sunken px-3 font-mono text-sm text-ink ' +
  'outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent'

let nextRowId = 0
const emptyRow = (): Row => ({ id: `row-${nextRowId++}`, key: '', value: '' })

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

/**
 * Les lignes sans nom sont ignorées plutôt que refusées : une ligne fraîchement
 * ajoutée est vide par construction, et faire échouer l'envoi pour elle serait plus
 * pénible qu'utile. Deux lignes de même nom se départagent par la dernière, comme le
 * ferait le CLI qui reçoit la table.
 */
const toRecord = (rows: Row[]): Record<string, string> =>
  Object.fromEntries(
    rows.filter((row) => row.key.trim().length > 0).map((row) => [row.key.trim(), row.value]),
  )

const fromRecord = (pairs: Record<string, string>): Row[] =>
  Object.entries(pairs).map(([key, value]) => ({ ...emptyRow(), key, value }))

/** Les arguments n'ont pas de nom : la valeur seule est saisie, dans `value`. */
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
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createServer.mutate(
      { name: form.name.trim(), enabled: true, transport: toTransport(form) },
      { onSuccess: () => setForm(EMPTY_FORM) },
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('mcp.section.title')} description={t('mcp.section.description')} />

      <Banner tone="info">{t('mcp.banner')}</Banner>
      <Banner tone="caution">{t('mcp.secrets')}</Banner>

      {isAdmin ? (
        <Card>
          <CardHeader title={t('mcp.create.title')} icon={<Plus size={16} />} />
          <CardBody>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <TransportFields form={form} onChange={setForm} />
              {errorOf(createServer.error) ? <Banner>{errorOf(createServer.error)}</Banner> : null}
              <Button type="submit" disabled={createServer.isPending} className="self-start">
                {createServer.isPending ? t('mcp.create.pending') : t('mcp.create.action')}
              </Button>
            </form>
          </CardBody>
        </Card>
      ) : (
        <Banner>{t('mcp.readonly')}</Banner>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-soft">{t('mcp.existing.title')}</h2>
        {servers.length === 0 ? (
          <EmptyState
            icon={<Plug size={22} />}
            title={t('mcp.empty.title')}
            description={t('mcp.empty.description')}
          />
        ) : (
          servers.map((server) => (
            <ServerCard key={server.id} server={server} canEdit={isAdmin} />
          ))
        )}
      </section>
    </div>
  )
}

/** Partagé par la création et l'édition : les deux éditent la même chose. */
function TransportFields({
  form,
  onChange,
}: {
  form: FormState
  onChange: (form: FormState) => void
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
    </>
  )
}

/**
 * Liste de lignes ajoutées à la demande.
 *
 * Sans `keyPlaceholder`, la ligne n'a qu'une valeur : c'est le cas des arguments, qui
 * sont une suite et non une table. Le même composant sert les deux pour que la
 * mécanique d'ajout et de retrait ne soit pas écrite deux fois.
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
    // Repart de l'enregistrement et non du dernier brouillon : rouvrir l'édition après
    // avoir annulé doit montrer ce qui est enregistré, pas ce qu'on avait abandonné.
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
              <Badge tone={server.enabled ? 'accent' : 'neutral'}>
                {t(server.enabled ? 'mcp.state.enabled' : 'mcp.state.disabled')}
              </Badge>
              <Badge>{server.transport.type}</Badge>
            </div>
            <p className="truncate font-mono text-xs text-ink-faint">
              {describeTransport(server.transport)}
            </p>
          </div>

          {canEdit ? (
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  updateServer.mutate({ id: server.id, enabled: !server.enabled })
                }
              >
                {t(server.enabled ? 'mcp.action.disable' : 'mcp.action.enable')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => (editing ? setEditing(false) : startEditing())}>
                {t(editing ? 'mcp.action.cancel' : 'mcp.action.edit')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 size={15} />}
                onClick={() => setConfirming(true)}
              >
                {t('mcp.action.delete')}
              </Button>
            </div>
          ) : null}
        </div>

        {editing ? (
          <form onSubmit={save} className="flex flex-col gap-4 rounded-md border border-line bg-sunken p-3">
            <TransportFields form={form} onChange={setForm} />
            {errorOf(updateServer.error) ? <Banner>{errorOf(updateServer.error)}</Banner> : null}
            <Button type="submit" disabled={updateServer.isPending} className="self-start">
              {updateServer.isPending ? t('mcp.action.saving') : t('mcp.action.save')}
            </Button>
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
