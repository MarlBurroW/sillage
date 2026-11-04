import { MoreHorizontal, Pencil, Plug, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { NavLink } from 'react-router-dom'
import type { McpServer } from '@sillage/protocol'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Select,
  Switch,
} from '../components/ui'
import {
  EMPTY_MCP_FORM,
  formToTransport,
  mcpErrorOf,
  serverToForm,
  TransportFields,
  type McpFormState,
} from '../components/mcp/McpServerForm'
import { ListHeading, SectionHeader } from './SettingsPage'
import { useTranslate } from '../lib/i18n'
import {
  describeTransport,
  useCreateMcpServer,
  useDeleteMcpServer,
  useMcpServers,
  useUpdateMcpServer,
  type McpServerInput,
} from '../lib/mcp'
import { useProjects } from '../lib/projects'
import { useCurrentUser } from '../lib/session'

/**
 * MCP server registry: instance-wide servers and servers scoped to one project, in a single list
 * so the page keeps one clear end. Scope shows as a badge on each row; the form chooses it.
 */

/** Select value for the instance-wide scope; project scopes use the project ID. */
const GLOBAL_SCOPE = ''

export function McpSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data } = useMcpServers()
  // Instance-wide first: they concern everyone; project servers follow, grouped by their order.
  const servers = [...(data?.servers ?? [])].sort((a, b) =>
    Number(a.projectId !== null) - Number(b.projectId !== null) || a.name.localeCompare(b.name),
  )

  const createServer = useCreateMcpServer()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<McpFormState>(EMPTY_MCP_FORM)
  const [scope, setScope] = useState(GLOBAL_SCOPE)

  const openForm = () => {
    setForm(EMPTY_MCP_FORM)
    setScope(GLOBAL_SCOPE)
    createServer.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createServer.mutate(
      { name: form.name.trim(), enabled: true, transport: formToTransport(form), projectId: scope || null },
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
                <ScopeSelect value={scope} onChange={setScope} />
                {mcpErrorOf(createServer.error) ? <Banner>{mcpErrorOf(createServer.error)}</Banner> : null}
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

/**
 * Instance-wide or one project. Projects the account cannot open are absent, like everywhere
 * else; an administrator still sees every project of the instance in the list of the API.
 */
function ScopeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslate()
  const projects = useProjects().data ?? []
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        label={t('mcp.scope.label')}
        value={value}
        onChange={onChange}
        options={[
          { value: GLOBAL_SCOPE, label: t('mcp.scope.global') },
          ...projects.map((project) => ({ value: project.id, label: t('mcp.scope.project', { name: project.name }) })),
        ]}
      />
      <p className="text-xs text-ink-faint">{t('mcp.scope.hint')}</p>
    </div>
  )
}

/** Name of a project server's project, for its badge; the ID when the project is not readable. */
function useProjectName(projectId: string | null): string | null {
  const projects = useProjects().data
  if (projectId === null) return null
  return projects?.find((project) => project.id === projectId)?.name ?? projectId
}

function ServerCard({ server, canEdit }: { server: McpServer; canEdit: boolean }) {
  const t = useTranslate()
  const updateServer = useUpdateMcpServer()
  const deleteServer = useDeleteMcpServer()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<McpFormState>(() => serverToForm(server))
  const [scope, setScope] = useState(server.projectId ?? GLOBAL_SCOPE)
  const [confirming, setConfirming] = useState(false)
  const projectName = useProjectName(server.projectId)

  const startEditing = () => {
    // Restart from the saved record, not the last draft: reopening after cancellation
    // must show saved values, not abandoned edits.
    setForm(serverToForm(server))
    setScope(server.projectId ?? GLOBAL_SCOPE)
    setEditing(true)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const patch: Partial<McpServerInput> = {
      name: form.name.trim(),
      transport: formToTransport(form),
      projectId: scope || null,
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
              {projectName ? <Badge tone="accent">{t('mcp.scope.project', { name: projectName })}</Badge> : null}
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

        {mcpErrorOf(updateServer.error) && !editing ? (
          <Banner>{mcpErrorOf(updateServer.error)}</Banner>
        ) : null}

        {editing ? (
          <form onSubmit={save} className="flex flex-col gap-4 rounded-md border border-line bg-sunken p-3">
            <TransportFields form={form} onChange={setForm} />
            <ScopeSelect value={scope} onChange={setScope} />
            {mcpErrorOf(updateServer.error) ? <Banner>{mcpErrorOf(updateServer.error)}</Banner> : null}
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
