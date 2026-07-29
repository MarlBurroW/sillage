import { Plug, Plus, Trash2 } from 'lucide-react'
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
  Select,
  TextArea,
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
 * Le formulaire garde les listes et les tables sous forme de texte, une entrée par
 * ligne, et ne les convertit qu'à l'envoi. Une structure éditée champ par champ
 * demanderait d'ajouter et de retirer des lignes à la souris là où un bloc de texte se
 * colle depuis la documentation du serveur qu'on installe.
 */

interface FormState {
  name: string
  type: McpTransport['type']
  command: string
  args: string
  env: string
  url: string
  headers: string
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
}

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/**
 * Une ligne sans séparateur est ignorée plutôt que refusée : elle arrive en cours de
 * frappe, et faire échouer l'envoi pour une ligne à moitié écrite serait plus pénible
 * qu'utile. Seul ce qui a la forme d'une paire est retenu.
 */
const parsePairs = (text: string, separator: string): Record<string, string> => {
  const pairs = linesOf(text).flatMap((line) => {
    const at = line.indexOf(separator)
    if (at <= 0) return []
    return [[line.slice(0, at).trim(), line.slice(at + separator.length).trim()] as const]
  })
  return Object.fromEntries(pairs)
}

const formatPairs = (pairs: Record<string, string>, separator: string): string =>
  Object.entries(pairs)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n')

const toTransport = (form: FormState): McpTransport =>
  form.type === 'stdio'
    ? {
        type: 'stdio',
        command: form.command.trim(),
        args: linesOf(form.args),
        env: parsePairs(form.env, '='),
      }
    : {
        type: form.type,
        url: form.url.trim(),
        headers: parsePairs(form.headers, ':'),
      }

const toForm = (server: McpServer): FormState => ({
  ...EMPTY_FORM,
  name: server.name,
  type: server.transport.type,
  ...(server.transport.type === 'stdio'
    ? {
        command: server.transport.command,
        args: server.transport.args.join('\n'),
        env: formatPairs(server.transport.env, '='),
      }
    : {
        url: server.transport.url,
        headers: formatPairs(server.transport.headers, ': '),
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
          <TextArea
            label={t('mcp.args.label')}
            hint={t('mcp.args.hint')}
            rows={3}
            value={form.args}
            onChange={(event) => onChange({ ...form, args: event.target.value })}
          />
          <TextArea
            label={t('mcp.env.label')}
            hint={t('mcp.env.hint')}
            rows={3}
            value={form.env}
            onChange={(event) => onChange({ ...form, env: event.target.value })}
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
          <TextArea
            label={t('mcp.headers.label')}
            hint={t('mcp.headers.hint')}
            rows={3}
            value={form.headers}
            onChange={(event) => onChange({ ...form, headers: event.target.value })}
          />
        </>
      )}
    </>
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
