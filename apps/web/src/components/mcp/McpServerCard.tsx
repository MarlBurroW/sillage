import { ProjectSelector } from '../ProjectSelector'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { McpServer } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { describeTransport, useDeleteMcpServer, useUpdateMcpServer, type McpServerInput } from '../../lib/mcp'
import { useProjects } from '../../lib/projects'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Switch,
} from '../ui'
import { formToTransport, mcpErrorOf, serverToForm, TransportFields, type McpFormState } from './McpServerForm'

/**
 * One registry entry, shared by the instance settings and the project page. The instance page
 * shows and edits the scope; the project page lists only its own servers, so the scope is implied.
 */

/** Select value for the instance-wide scope; project scopes use the project ID. */
export const GLOBAL_SCOPE = ''

/**
 * Instance-wide or one project. Projects the account cannot open are absent, like everywhere
 * else; an administrator still sees every project of the instance in the list of the API.
 */
export function ScopeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslate()
  const projects = useProjects().data ?? []
  return (
    <div className="flex flex-col gap-1.5">
      <ProjectSelector
        label={t('mcp.scope.label')}
        value={value}
        onChange={onChange}
        options={[
          { value: GLOBAL_SCOPE, label: t('mcp.scope.global') },
          ...projects.map((project) => ({ value: project.id, label: project.name, project })),
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

export function McpServerCard({
  server,
  canEdit,
  showScope = true,
}: {
  server: McpServer
  canEdit: boolean
  /** Badge and scope field; off where every listed server shares the same scope. */
  showScope?: boolean
}) {
  const t = useTranslate()
  const updateServer = useUpdateMcpServer()
  const deleteServer = useDeleteMcpServer()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<McpFormState>(() => serverToForm(server))
  const [scope, setScope] = useState(server.projectId ?? GLOBAL_SCOPE)
  const [confirming, setConfirming] = useState(false)
  const projectName = useProjectName(showScope ? server.projectId : null)

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
      ...(showScope ? { projectId: scope || null } : {}),
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
            {showScope ? <ScopeSelect value={scope} onChange={setScope} /> : null}
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
