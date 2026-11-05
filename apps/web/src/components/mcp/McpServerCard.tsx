import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { McpServer } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { describeTransport, useDeleteMcpServer, useUpdateMcpServer } from '../../lib/mcp'
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
 * One registry entry, shared by the global settings and the project page. Each page lists a single
 * scope, set when the server is declared, so the card neither shows nor changes it.
 */
export function McpServerCard({ server, canEdit }: { server: McpServer; canEdit: boolean }) {
  const t = useTranslate()
  const updateServer = useUpdateMcpServer()
  const deleteServer = useDeleteMcpServer()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<McpFormState>(() => serverToForm(server))
  const [confirming, setConfirming] = useState(false)

  const startEditing = () => {
    // Restart from the saved record, not the last draft: reopening after cancellation
    // must show saved values, not abandoned edits.
    setForm(serverToForm(server))
    setEditing(true)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    updateServer.mutate(
      { id: server.id, name: form.name.trim(), transport: formToTransport(form) },
      { onSuccess: () => setEditing(false) },
    )
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

        {mcpErrorOf(updateServer.error) && !editing ? (
          <Banner>{mcpErrorOf(updateServer.error)}</Banner>
        ) : null}

        {editing ? (
          <form onSubmit={save} className="flex flex-col gap-4 rounded-md border border-line bg-sunken p-3">
            <TransportFields form={form} onChange={setForm} />
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
