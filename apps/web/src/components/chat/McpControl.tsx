import { TooltipButton } from '../ui/Tooltip'
import { PlugZap } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { McpServer, McpServerStatus } from '@sillage/protocol'
import { translate, useTranslate } from '../../lib/i18n'
import { Menu, MenuCheckboxItem, MenuLabel, MenuSeparator, cx } from '../ui'
import { toolButtonClass } from './composer-buttons'

/**
 * Conversation MCP servers and Claude strict isolation. Together they answer which tools the agent
 * uses; separating them would require two settings to understand actual CLI inventory. Also show
 * CLI-declared servers Sillage cannot configure: hiding them made None appear despite seven
 * available tools, true about controlled settings but false about loaded tools. Offer strictMcp
 * only for Claude and say so. Codex has no equivalent: config.toml and its embedded server remain,
 * so offering the same switch would falsely promise isolation.
 */

export interface McpControlProps {
  presentation?: 'menu' | 'panel'
  /** Phone composer: visually smaller button with unchanged touch target. */
  narrow?: boolean
  /** Sillage registry, the only servers this control can toggle. */
  servers: McpServer[]
  /**
   * CLI-reported session inventory. Idle conversations have no process and fall back to configured
   * state for lack of better information.
   */
  inventory: McpServerStatus[]
  selected: string[]
  onSelectedChange: (ids: string[]) => void
  /**
   * Sillage MCP server or null if the instance does not mount it. Null removes rather than disables
   * the row: visible ineffective controls invite troubleshooting, while absence correctly indicates
   * an unavailable feature.
   */
  sillage: boolean | null
  onSillageChange: (enabled: boolean) => void
  /** Null for Codex, which has no configurable isolation. */
  strict: boolean | null
  onStrictChange: (strict: boolean) => void
  disabled?: boolean
}

export function McpControl({
  presentation = 'menu',
  servers,
  inventory,
  selected,
  onSelectedChange,
  sillage,
  onSillageChange,
  strict,
  onStrictChange,
  disabled = false,
  narrow = false,
}: McpControlProps) {
  const t = useTranslate()
  const CheckboxItem = presentation === 'panel' ? McpSwitch : MenuCheckboxItem
  const Separator = presentation === 'panel' ? McpDivider : MenuSeparator
  const active = new Set(selected)
  const external = inventory.filter((server) => server.external)
  const toolsByName = new Map(inventory.map((server) => [server.name, server.tools.length]))

  const toggle = (id: string, checked: boolean) => {
    // Rebuild in registry order rather than appending: order resolves tool-name collisions and must
    // not depend on click sequence.
    const next = new Set(active)
    if (checked) next.add(id)
    else next.delete(id)
    onSelectedChange(servers.filter((server) => next.has(server.id)).map((server) => server.id))
  }

  // strictMcp overrides activation: only declared servers are allowed, excluding Sillage with the
  // others. Keep its state visible but inert during isolation.
  const sillageActive = sillage === true && strict !== true

  const items = (
    <>
      {sillage === null ? null : (
        <>
          <CheckboxItem
            checked={sillage}
            onCheckedChange={onSillageChange}
            disabled={disabled || strict === true}
          >
            <span className="flex flex-col">
              <span>{t('composer.mcp.builtin')}</span>
              <span className="text-[0.6875rem] text-ink-faint">
                {t('composer.mcp.builtin.hint')}
              </span>
            </span>
          </CheckboxItem>
          <Separator />
        </>
      )}

      {servers.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('composer.mcp.empty')}</p>
      ) : (
        <>
          {/* Headings are needed only to distinguish sections; without CLI servers one section needs no name. */}
          {external.length > 0 ? <MenuLabel>{t('composer.mcp.sillage')}</MenuLabel> : null}
          {servers.map((server) => (
            <CheckboxItem
              key={server.id}
              checked={active.has(server.id)}
              onCheckedChange={(checked) => toggle(server.id, checked)}
              disabled={disabled || !server.enabled}
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="min-w-0 truncate">{server.name}</span>
                <ToolCount count={toolsByName.get(server.name)} />
              </span>
            </CheckboxItem>
          ))}
        </>
      )}

      {external.length > 0 ? (
        <>
          <Separator />
          <MenuLabel>{t('composer.mcp.fromCli')}</MenuLabel>
          {external.map((server) => (
            // Use an inert row rather than disabled checkbox, which would imply Sillage could
            // eventually configure a server it never declared.
            <div
              key={server.name}
              className="flex items-baseline gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink-faint"
            >
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
              <ToolCount count={server.tools.length} />
            </div>
          ))}
          <p className="px-2.5 pb-1 text-[0.6875rem] text-ink-faint">
            {t('composer.mcp.fromCli.hint')}
          </p>
        </>
      ) : null}

      {strict === null ? null : (
        <>
          <Separator />
          <CheckboxItem checked={strict} onCheckedChange={onStrictChange} disabled={disabled}>
            <span className="flex flex-col">
              <span>{t('composer.mcp.strict')}</span>
              <span className="text-[0.6875rem] text-ink-faint">{t('composer.mcp.strict.hint')}</span>
            </span>
          </CheckboxItem>
        </>
      )}

      <Separator />
      <Link
        to="/settings/mcp"
        className="flex min-h-11 items-center rounded-md px-2.5 py-2 text-sm text-ink-soft hover:bg-accent-wash hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t('composer.mcp.manage')}
      </Link>
    </>
  )

  // Icon/count badge rather than named selector: inventory is glanceable and needs less space than
  // per-turn settings. Count Sillage before CLI response too: it provides tools, and omitting it
  // would claim None despite project memory on startup.
  const configured = selected.length + (sillageActive ? 1 : 0)
  const summary = mcpSummary(configured, inventory.length)
  const count = inventory.length > 0 ? inventory.length : configured

  if (presentation === 'panel') return <div>{items}</div>

  return (
    <Menu
      align="start"
      trigger={
        <TooltipButton
          type="button"
          disabled={disabled}
          aria-label={t('composer.mcp.label', { summary })}
          title={summary}
          className={cx(toolButtonClass(narrow), 'relative tabular-nums')}
        >
          <PlugZap size={16} className="shrink-0" />
          {/*
           * Omit zero because it suggests failure, like tool counts before CLI response. Badge
           * sizing keeps the trigger icon-sized.
           */}
          {count > 0 ? <span aria-hidden className="absolute top-0.5 right-0 min-w-3.5 rounded-full bg-accent-wash px-1 text-center text-[0.625rem] leading-3.5 text-ink">{count}</span> : null}
        </TooltipButton>
      }
    >
      {items}
    </Menu>
  )
}

/** Menu choices as ordinary controls within the panel. */
function McpSwitch({ checked, onCheckedChange, disabled, children }: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm text-ink-soft hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="min-w-0 flex-1 wrap-anywhere">{children}</span>
      <span aria-hidden className={cx('flex h-5 w-8 shrink-0 items-center rounded-full p-0.5', checked ? 'justify-end bg-accent' : 'bg-line-strong')}>
        <span className="size-4 rounded-full bg-surface" />
      </span>
    </button>
  )
}

function McpDivider() { return <div className="my-2 h-px bg-line" /> }

/** Absent until CLI response: zero tools would look like failure. */
function ToolCount({ count }: { count: number | undefined }) {
  const t = useTranslate()
  if (count === undefined || count === 0) return null

  return (
    <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
      {t(count > 1 ? 'composer.mcp.tools.many' : 'composer.mcp.tools.one', { count })}
    </span>
  )
}

/**
 * Composer summary for the collapsed trigger. Once available count actual session inventory,
 * including CLI servers undeclared in Sillage, rather than configuration. Idle conversations lack
 * inventory and fall back to configured counts. Compute during render rather than module
 * initialization so labels follow language changes.
 */
export function mcpSummary(configured: number, loaded: number): string {
  if (loaded > 0) {
    return translate(loaded > 1 ? 'composer.mcp.loaded.many' : 'composer.mcp.loaded.one', {
      count: loaded,
    })
  }
  if (configured === 0) return translate('composer.mcp.none')
  return translate(configured > 1 ? 'composer.mcp.count.many' : 'composer.mcp.count.one', {
    count: configured,
  })
}
