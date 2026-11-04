import { PlugZap } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { referencedSecrets, type McpInstallScope } from '@sillage/protocol'
import type { McpInstallItem } from '../../lib/chat-fold'
import { useConversation } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { answerMcpInstall, useInvalidateMcpServers } from '../../lib/mcp'
import { useProjects } from '../../lib/projects'
import { useSecrets } from '../../lib/secrets'
import { useCurrentUser } from '../../lib/session'
import { formToTransport, transportToForm, TransportFields } from '../mcp/McpServerForm'
import { Badge, Button, ChoiceList, Field, cx } from '../ui'

/**
 * An MCP server proposed by the agent, confirmed here rather than applied blindly: the user sees
 * every parameter the model wrote, can correct it, chooses the scope, and types the secrets the
 * agent only referenced. The values go to the encrypted store with the answer and never appear
 * in the thread.
 */
export function McpInstallPrompt({
  conversationId,
  item,
  canDecide,
}: {
  conversationId: string
  item: McpInstallItem
  canDecide: boolean
}) {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: conversation } = useConversation(conversationId)
  const projectId = conversation?.projectId ?? null
  const project = useProjects().data?.find((candidate) => candidate.id === projectId)
  // Only administrators may list secrets, and only they can install.
  const stored = useSecrets(isAdmin && item.status === 'pending').data?.secrets ?? []
  const invalidateRegistry = useInvalidateMcpServers()

  const [form, setForm] = useState(() => transportToForm(item.name, item.transport))
  const [scope, setScope] = useState<McpInstallScope>(projectId ? item.scope : 'global')
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Follow the edited form rather than the proposal: a reference the user adds needs a field, one
  // they remove must not block the submission.
  const referenced = useMemo(() => {
    const transport = formToTransport(form)
    const values = Object.values(transport.type === 'stdio' ? transport.env : transport.headers)
    return [...new Set(values.flatMap((value) => referencedSecrets(value)))]
  }, [form])
  const storedNames = new Set(stored.map((secret) => secret.name))
  const needsValue = (name: string) => !storedNames.has(name) || replacing[name] === true

  const STATUS_LABEL: Record<Exclude<McpInstallItem['status'], 'pending'>, string> = {
    installed: t('mcpInstall.status.installed'),
    declined: t('mcpInstall.status.declined'),
    expired: t('mcpInstall.status.expired'),
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const secrets = Object.fromEntries(
        referenced.filter(needsValue).map((name) => [name, secretValues[name]?.trim() ?? ''] as const).filter(([, value]) => value.length > 0),
      )
      await answerMcpInstall(conversationId, item.id, {
        decision: 'installed',
        name: form.name.trim(),
        transport: formToTransport(form),
        scope: projectId ? scope : 'global',
        secrets,
      })
      await invalidateRegistry()
    } catch (err) {
      // Await mcp_install.resolved from the server instead of predicting state, like permissions.
      setError(err instanceof Error ? err.message : t('mcpInstall.error.generic'))
      setBusy(false)
    }
  }

  const decline = async () => {
    setBusy(true)
    setError(null)
    try {
      await answerMcpInstall(conversationId, item.id, { decision: 'declined' })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mcpInstall.error.generic'))
      setBusy(false)
    }
  }

  const pending = item.status === 'pending'

  return (
    <div
      className={cx(
        'rounded-lg border p-3',
        pending ? 'border-accent bg-accent-wash/40 shadow-card' : 'border-line bg-surface/60',
      )}
    >
      <div className="flex items-start gap-2.5">
        <PlugZap size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {pending
              ? t('mcpInstall.title.pending', { name: item.name })
              : t('mcpInstall.title.past', { name: item.installedName ?? item.name })}
          </p>
          {item.purpose ? <p className="mt-0.5 text-xs text-ink-soft">{item.purpose}</p> : null}
          {item.status === 'installed' ? (
            <p className="mt-0.5 text-xs text-ink-faint">
              {t(item.installedScope === 'project' ? 'mcpInstall.installed.project' : 'mcpInstall.installed.global', {
                project: project?.name ?? '',
              })}
            </p>
          ) : null}
        </div>
        {item.status !== 'pending' ? (
          <Badge tone={item.status === 'installed' ? 'positive' : 'neutral'}>{STATUS_LABEL[item.status]}</Badge>
        ) : null}
      </div>

      {pending && canDecide ? (
        <form onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-4">
          <p className="text-xs text-ink-faint">{t('mcpInstall.review')}</p>
          <fieldset disabled={!isAdmin || busy} className="flex min-w-0 flex-col gap-4">
            <TransportFields form={form} onChange={setForm} secretsBanner={false} />

            {referenced.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken p-3">
                <div>
                  <p className="text-sm font-medium text-ink-soft">{t('mcpInstall.secrets.title')}</p>
                  <p className="text-xs text-ink-faint">{t('mcpInstall.secrets.hint')}</p>
                </div>
                {referenced.map((name) => (
                  <div key={name} className="flex flex-col gap-1.5">
                    {needsValue(name) ? (
                      <Field
                        label={name}
                        hint={item.secretHints[name]}
                        type="password"
                        value={secretValues[name] ?? ''}
                        onChange={(event) => setSecretValues((prev) => ({ ...prev, [name]: event.target.value }))}
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        required
                      />
                    ) : (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-mono text-xs">{name}</span>
                        <Badge tone="positive">{t('mcpInstall.secret.existing')}</Badge>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing((prev) => ({ ...prev, [name]: true }))}>
                          {t('mcpInstall.secret.replace')}
                        </Button>
                      </div>
                    )}
                    {needsValue(name) && storedNames.has(name) ? (
                      <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => setReplacing((prev) => ({ ...prev, [name]: false }))}>
                        {t('mcpInstall.secret.keep')}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {projectId ? (
              <ChoiceList
                label={t('mcpInstall.scope.label')}
                value={scope}
                onChange={setScope}
                options={[
                  {
                    value: 'project' as const,
                    label: t('mcpInstall.scope.project'),
                    hint: t('mcpInstall.scope.project.hint', { project: project?.name ?? '' }),
                  },
                  { value: 'global' as const, label: t('mcpInstall.scope.global'), hint: t('mcpInstall.scope.global.hint') },
                ]}
              />
            ) : null}
          </fieldset>

          {!isAdmin ? <p className="text-xs text-ink-faint">{t('mcpInstall.adminOnly')}</p> : null}

          <div className="flex flex-wrap gap-2">
            {isAdmin ? (
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? t('mcpInstall.installing') : t('mcpInstall.install')}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => void decline()}>
              {t('mcpInstall.decline')}
            </Button>
          </div>
        </form>
      ) : null}

      {pending && !canDecide ? <p className="mt-2 text-xs text-ink-faint">{t('mcpInstall.ownerOnly')}</p> : null}

      {error ? <p className="mt-2 text-xs text-critical">{error}</p> : null}
    </div>
  )
}
