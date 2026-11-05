import { Plug, PlugZap, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslate } from '../../lib/i18n'
import { useCreateMcpServer, useMcpServers } from '../../lib/mcp'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState } from '../ui'
import { McpServerCard } from './McpServerCard'
import { EMPTY_MCP_FORM, formToTransport, mcpErrorOf, TransportFields, type McpFormState } from './McpServerForm'

/**
 * Servers scoped to one project, managed where the project is configured, by its owner like the
 * rest of the page. Global servers stay in the settings: they concern every project, and listing
 * them here would suggest they can be edited per project; only their count is recalled, as for
 * skills. The same registry serves both pages; only the scope differs.
 */
export function ProjectMcpServers({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const t = useTranslate()
  const all = useMcpServers().data?.servers ?? []
  const servers = all.filter((server) => server.projectId === projectId)
  const globals = all.filter((server) => server.projectId === null).length
  const createServer = useCreateMcpServer()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<McpFormState>(EMPTY_MCP_FORM)

  const openForm = () => {
    setForm(EMPTY_MCP_FORM)
    createServer.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createServer.mutate(
      { name: form.name.trim(), enabled: true, transport: formToTransport(form), projectId },
      { onSuccess: () => setAdding(false) },
    )
  }

  const addButton = isOwner ? (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={openForm}>
      {t('mcp.create.open')}
    </Button>
  ) : null

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t('project.mcp.title')}
          description={t('project.mcp.description')}
          icon={<PlugZap size={16} />}
        />
        <CardBody className="flex flex-col gap-3">
          {globals > 0 ? (
            <p className="text-sm text-ink-faint">
              {t('project.mcp.globals', { count: globals })}{' '}
              <Link to="/settings/mcp" className="text-accent hover:underline">
                {t('project.mcp.globals.link')}
              </Link>
            </p>
          ) : null}
          {/* Below the header rather than beside it: on phones the title would wrap around the button. */}
          {servers.length > 0 && !adding && addButton ? <div className="flex justify-end">{addButton}</div> : null}

          {adding ? (
            <form onSubmit={submit} className="flex flex-col gap-4 rounded-md border border-line bg-sunken p-3">
              <TransportFields form={form} onChange={setForm} autoFocus />
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
          ) : null}

          {servers.length === 0 && !adding ? (
            <EmptyState
              icon={<Plug size={22} />}
              title={t('project.mcp.empty.title')}
              description={t(isOwner ? 'project.mcp.empty.description' : 'project.mcp.empty.member')}
              action={addButton}
            />
          ) : null}
        </CardBody>
      </Card>

      {servers.map((server) => (
        <McpServerCard key={server.id} server={server} canEdit={isOwner} />
      ))}
    </div>
  )
}
