import { Plug, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { NavLink } from 'react-router-dom'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState } from '../components/ui'
import { GLOBAL_SCOPE, McpServerCard, ScopeSelect } from '../components/mcp/McpServerCard'
import { EMPTY_MCP_FORM, formToTransport, mcpErrorOf, TransportFields, type McpFormState } from '../components/mcp/McpServerForm'
import { ListHeading, SectionHeader } from './SettingsPage'
import { useTranslate } from '../lib/i18n'
import { useCreateMcpServer, useMcpServers } from '../lib/mcp'
import { useCurrentUser } from '../lib/session'

/**
 * MCP server registry: instance-wide servers and servers scoped to one project, in a single list
 * so the page keeps one clear end. Scope shows as a badge on each row; the form chooses it.
 */

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
            <McpServerCard key={server.id} server={server} canEdit={isAdmin} />
          ))
        )}
      </section>
    </div>
  )
}
