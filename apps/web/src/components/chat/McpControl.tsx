import { PlugZap } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { McpServer, McpServerStatus } from '@sillage/protocol'
import { translate, useTranslate } from '../../lib/i18n'
import { Menu, MenuCheckboxItem, MenuLabel, MenuSeparator, cx } from '../ui'

/**
 * Serveurs MCP actifs sur la conversation, et l'isolation stricte de Claude.
 *
 * Les deux vivent dans le même contrôle parce qu'ils répondent à la même question,
 * « avec quels outils cet agent travaille » : les séparer obligerait à ouvrir deux
 * réglages pour comprendre ce que le CLI a réellement chargé.
 *
 * C'est cette même question qui justifie d'y montrer les serveurs venus du CLI, que
 * Sillage n'a pas déclarés et ne peut pas régler. Les taire donnait un composeur qui
 * annonçait « Aucun » à une session où l'agent disposait déjà de sept outils : le
 * réglage disait vrai sur ce qu'il contrôle, et faux sur ce qui est chargé.
 *
 * `strictMcp` n'est proposé que pour Claude, et le dit. Codex n'a pas d'équivalent :
 * son `config.toml` et son serveur intégré restent là quoi qu'on fasse, et offrir la
 * bascule des deux côtés promettrait une isolation qu'un des deux ne tient pas.
 */

interface McpControlProps {
  /** Registre de Sillage : le seul que ce contrôle peut activer ou désactiver. */
  servers: McpServer[]
  /**
   * Inventaire que le CLI rapporte pour la session en cours.
   *
   * Vide sur une conversation au repos, qui n'a pas de process : le contrôle retombe
   * alors sur ce que la configuration décrit, faute de mieux.
   */
  inventory: McpServerStatus[]
  selected: string[]
  onSelectedChange: (ids: string[]) => void
  /** Null pour Codex, qui n'a pas d'isolation à régler. */
  strict: boolean | null
  onStrictChange: (strict: boolean) => void
  disabled?: boolean
}

export function McpControl({
  servers,
  inventory,
  selected,
  onSelectedChange,
  strict,
  onStrictChange,
  disabled = false,
}: McpControlProps) {
  const t = useTranslate()
  const active = new Set(selected)
  const external = inventory.filter((server) => server.external)
  const toolsByName = new Map(inventory.map((server) => [server.name, server.tools.length]))

  const toggle = (id: string, checked: boolean) => {
    // Reconstruit depuis l'ordre du registre plutôt qu'en ajoutant en fin de liste :
    // l'ordre décide quel serveur l'emporte quand deux exposent un outil homonyme, et
    // il ne doit pas dépendre de l'ordre des clics.
    const next = new Set(active)
    if (checked) next.add(id)
    else next.delete(id)
    onSelectedChange(servers.filter((server) => next.has(server.id)).map((server) => server.id))
  }

  const items = (
    <>
      {servers.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('composer.mcp.empty')}</p>
      ) : (
        <>
          {/* L'intitulé n'apparaît que s'il y a de quoi le distinguer d'autre chose :
              sans serveur du CLI, une seule section n'a pas besoin d'être nommée. */}
          {external.length > 0 ? <MenuLabel>{t('composer.mcp.sillage')}</MenuLabel> : null}
          {servers.map((server) => (
            <MenuCheckboxItem
              key={server.id}
              checked={active.has(server.id)}
              onCheckedChange={(checked) => toggle(server.id, checked)}
              disabled={disabled || !server.enabled}
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="min-w-0 truncate">{server.name}</span>
                <ToolCount count={toolsByName.get(server.name)} />
              </span>
            </MenuCheckboxItem>
          ))}
        </>
      )}

      {external.length > 0 ? (
        <>
          <MenuSeparator />
          <MenuLabel>{t('composer.mcp.fromCli')}</MenuLabel>
          {external.map((server) => (
            // Une ligne inerte plutôt qu'une case grisée : une case, même désactivée,
            // laisse croire qu'elle deviendra cochable, alors que Sillage ne pourra
            // jamais régler un serveur qu'il n'a pas déclaré.
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
          <MenuSeparator />
          <MenuCheckboxItem checked={strict} onCheckedChange={onStrictChange} disabled={disabled}>
            <span className="flex flex-col">
              <span>{t('composer.mcp.strict')}</span>
              <span className="text-[0.6875rem] text-ink-faint">{t('composer.mcp.strict.hint')}</span>
            </span>
          </MenuCheckboxItem>
        </>
      )}

      <MenuSeparator />
      <Link
        to="/settings/mcp"
        className="block rounded-md px-2.5 py-2 text-sm text-ink-soft hover:bg-accent-wash hover:text-ink"
      >
        {t('composer.mcp.manage')}
      </Link>
    </>
  )

  // Une pastille d'icône et de compte plutôt qu'un sélecteur nommé : la question
  // « avec quels outils » se lit d'un coup d'œil et ne mérite pas d'occuper la barre
  // à hauteur des réglages qu'on change à chaque tour.
  const summary = mcpSummary(selected.length, inventory.length)
  const count = inventory.length > 0 ? inventory.length : selected.length

  return (
    <Menu
      align="start"
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={t('composer.mcp.label', { summary })}
          title={summary}
          className={cx(
            'flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-xs tabular-nums',
            'border border-transparent bg-transparent text-ink-faint transition-colors',
            'hover:bg-surface-high hover:text-ink',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
            'data-[state=open]:bg-surface-high data-[state=open]:text-ink',
            'disabled:pointer-events-none disabled:opacity-45',
          )}
        >
          <PlugZap size={14} className="shrink-0" />
          {/* Rien à zéro : un « 0 » se lirait comme une panne, pour la même raison
              que le compte d'outils reste muet tant que le CLI n'a pas répondu. */}
          {count > 0 ? <span>{count}</span> : null}
        </button>
      }
    >
      {items}
    </Menu>
  )
}

/** Absent tant que le CLI n'a pas répondu : un « 0 outil » se lirait comme un échec. */
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
 * Résumé affiché par le composer sur son déclencheur replié.
 *
 * Compte ce que la session a réellement chargé dès que le CLI l'a dit, et non ce que
 * la configuration décrit : c'est la question à laquelle ce contrôle sert à répondre,
 * et les serveurs du CLI en font partie sans que Sillage les ait déclarés. Une
 * conversation au repos n'a pas d'inventaire, le compte configuré prend alors le
 * relais faute de mieux.
 *
 * Fonction appelée au rendu et non constante de module : un libellé composé au
 * chargement se figerait dans la langue d'alors et resterait en place après un
 * changement de langue.
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
