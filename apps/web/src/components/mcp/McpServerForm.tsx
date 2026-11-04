import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { McpServer, McpTransport } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import { useSecrets } from '../../lib/secrets'
import { useCurrentUser } from '../../lib/session'
import { Banner, Button, Field, IconButton, Select, cx } from '../ui'

/**
 * MCP server form shared by the settings registry and the in-conversation installation prompt.
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
export interface Row {
  id: string
  key: string
  value: string
}

export interface McpFormState {
  name: string
  type: McpTransport['type']
  command: string
  args: Row[]
  env: Row[]
  url: string
  /**
   * Bearer is the usual scheme for remote MCP servers: a dedicated field spares users from
   * remembering the header name and the `Bearer ` prefix, which were easy to get wrong.
   */
  auth: 'none' | 'bearer'
  /** Raw token or a `{{secret.NAME}}` reference, without the `Bearer ` prefix. */
  token: string
  headers: Row[]
}

export const EMPTY_MCP_FORM: McpFormState = {
  name: '',
  type: 'stdio',
  command: '',
  args: [],
  env: [],
  url: '',
  auth: 'none',
  token: '',
  headers: [],
}

const BEARER = /^Bearer\s+(.+)$/i
const isAuthorization = (key: string) => key.trim().toLowerCase() === 'authorization'

/** Exact single-secret reference, the case the secret picker can represent. */
const SECRET_REFERENCE = /^\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}$/

/** Shared row-field styling, with each field retaining its own width. */
const ROW_INPUT =
  'tap-target min-w-0 rounded-md border border-line bg-sunken px-3 font-mono text-sm text-ink ' +
  'outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent'

let nextRowId = 0
const emptyRow = (): Row => ({ id: `row-${nextRowId++}`, key: '', value: '' })

export const mcpErrorOf = (error: unknown): string | null =>
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

export const formToTransport = (form: McpFormState): McpTransport =>
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
        headers: form.auth === 'bearer' && form.token.trim().length > 0
          ? {
              // Drop any manual Authorization row so the CLI does not receive two values whose
              // precedence depends on header-name casing.
              ...toRecord(form.headers.filter((row) => !isAuthorization(row.key))),
              Authorization: `Bearer ${form.token.trim()}`,
            }
          : toRecord(form.headers),
      }

/** Lift a stored `Authorization: Bearer …` header back into the dedicated field. */
const fromHeaders = (headers: Record<string, string>): Pick<McpFormState, 'auth' | 'token' | 'headers'> => {
  const entry = Object.entries(headers).find(([key, value]) => isAuthorization(key) && BEARER.test(value))
  if (!entry) return { auth: 'none', token: '', headers: fromRecord(headers) }
  const rest = Object.fromEntries(Object.entries(headers).filter(([key]) => key !== entry[0]))
  return { auth: 'bearer', token: entry[1].match(BEARER)?.[1] ?? '', headers: fromRecord(rest) }
}

export const transportToForm = (name: string, transport: McpTransport): McpFormState => ({
  ...EMPTY_MCP_FORM,
  name,
  type: transport.type,
  ...(transport.type === 'stdio'
    ? {
        command: transport.command,
        args: fromValues(transport.args),
        env: fromRecord(transport.env),
      }
    : {
        url: transport.url,
        ...fromHeaders(transport.headers),
      }),
})

export const serverToForm = (server: McpServer): McpFormState => transportToForm(server.name, server.transport)

/** Shared by creation and editing: both edit the same data. */
export function TransportFields({
  form,
  onChange,
  autoFocus = false,
  secretsBanner = true,
}: {
  form: McpFormState
  onChange: (form: McpFormState) => void
  /** Focus the first field of the newly opened form. */
  autoFocus?: boolean
  /** The installation prompt explains secrets with its own fields; the registry form needs the reminder. */
  secretsBanner?: boolean
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
          <BearerFields form={form} onChange={onChange} />
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
      {secretsBanner ? <Banner tone="caution">{t('mcp.secrets')}</Banner> : null}
    </>
  )
}

/**
 * Authentication section of remote transports. Stored secrets are offered first: a pasted token
 * is kept as plain text, and the picker makes the safer choice the shortest one.
 */
function BearerFields({ form, onChange }: { form: McpFormState; onChange: (form: McpFormState) => void }) {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  // Only administrators edit MCP servers, and only they may list secrets.
  const secrets = useSecrets(me?.isAdmin === true).data?.secrets ?? []
  const referenced = form.token.trim().match(SECRET_REFERENCE)?.[1]
  const [typing, setTyping] = useState(false)
  // A reference the store does not know yet (an agent proposal) stays as typed text: the
  // installation form collects its value separately.
  const source = !typing && referenced && secrets.some((secret) => secret.name === referenced)
    ? `secret:${referenced}`
    : 'literal'

  return (
    <div className="flex flex-col gap-3">
      <Select
        label={t('mcp.auth.label')}
        value={form.auth}
        onChange={(auth) => onChange({ ...form, auth })}
        options={[
          { value: 'none' as const, label: t('mcp.auth.none') },
          { value: 'bearer' as const, label: t('mcp.auth.bearer') },
        ]}
      />
      {form.auth === 'bearer' ? (
        <>
          {secrets.length > 0 ? (
            <Select
              label={t('mcp.auth.source')}
              value={source}
              onChange={(value) => {
                if (value === 'literal') {
                  setTyping(true)
                  // Leaving a secret empties the field rather than showing its reference as text.
                  onChange({ ...form, token: referenced ? '' : form.token })
                  return
                }
                setTyping(false)
                onChange({ ...form, token: `{{secret.${value.slice('secret:'.length)}}}` })
              }}
              options={[
                ...secrets.map((secret) => ({ value: `secret:${secret.name}`, label: secret.name })),
                { value: 'literal', label: t('mcp.auth.literal') },
              ]}
            />
          ) : null}
          {source === 'literal' ? (
            <div className="flex flex-col gap-1.5">
              <Field
                label={t('mcp.auth.token')}
                type={referenced ? 'text' : 'password'}
                value={form.token}
                onChange={(event) => onChange({ ...form, token: event.target.value })}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
              <p className="text-xs text-ink-faint">
                {t('mcp.auth.token.hint')}{' '}
                <Link to="/settings/secrets" className="text-accent hover:underline">
                  {t('mcp.auth.token.secrets')}
                </Link>
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
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
