import { Braces, ChevronRight, Filter } from 'lucide-react'
import { useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Un appel reçu, déplié en arbre. Chaque ligne porte son chemin pointé et deux gestes :
 * filtrer sur ce champ, ou le citer dans le prompt. C'est ce qui évite d'écrire un
 * chemin à la main, et de se tromper d'un niveau.
 */
export function PayloadTree({
  value,
  root,
  onFilter,
  onInsert,
}: {
  value: unknown
  /** Préfixe des chemins : `payload`, `headers`… */
  root: string
  onFilter: (path: string, value: unknown) => void
  onInsert: (path: string) => void
}) {
  const t = useTranslate()
  if (value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0)) {
    return <p className="px-2 py-3 text-xs text-ink-faint">{t('automation.tree.empty')}</p>
  }
  return (
    <ul role="tree" className="font-mono text-xs">
      {entries(value).map(([key, child]) => (
        <Node key={key} name={key} value={child} path={`${root}.${key}`} depth={0} onFilter={onFilter} onInsert={onInsert} />
      ))}
    </ul>
  )
}

function entries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item])
  if (value && typeof value === 'object') return Object.entries(value)
  return []
}

const MAX_PREVIEW = 120

function Node({
  name,
  value,
  path,
  depth,
  onFilter,
  onInsert,
}: {
  name: string
  value: unknown
  path: string
  depth: number
  onFilter: (path: string, value: unknown) => void
  onInsert: (path: string) => void
}) {
  const t = useTranslate()
  const branch = value !== null && typeof value === 'object'
  const children = branch ? entries(value) : []
  // Les deux premiers niveaux ouverts : c'est là que sont `action`, `issue`, `sender`.
  const [open, setOpen] = useState(depth < 1)

  const preview = (() => {
    if (branch) return Array.isArray(value) ? `[${children.length}]` : `{${children.length}}`
    if (typeof value === 'string') return JSON.stringify(value.length > MAX_PREVIEW ? `${value.slice(0, MAX_PREVIEW)}…` : value)
    return String(value)
  })()
  const tone =
    typeof value === 'string' ? 'text-positive'
      : typeof value === 'number' ? 'text-accent'
        : typeof value === 'boolean' || value === null ? 'text-caution'
          : 'text-ink-faint'

  return (
    <li role="treeitem" aria-expanded={branch ? open : undefined}>
      <div
        className="group/node flex min-h-7 items-center gap-1 rounded py-0.5 pr-1 hover:bg-surface-high"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <button
          type="button"
          disabled={!branch}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={path}
        >
          <ChevronRight
            size={12}
            className={cx('shrink-0 text-ink-faint transition-transform', !branch && 'invisible', open && 'rotate-90')}
          />
          <span className="shrink-0 text-ink-soft">{name}</span>
          <span className="shrink-0 text-ink-faint">:</span>
          <span className={cx('min-w-0 truncate', tone)} title={typeof value === 'string' ? value : undefined}>{preview}</span>
        </button>
        {/* Visibles au survol et au clavier ; toujours là au doigt, où rien ne survole. */}
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/node:opacity-100 group-hover/node:opacity-100 pointer-coarse:opacity-100">
          <button
            type="button"
            onClick={() => onFilter(path, value)}
            title={t('automation.tree.filter', { path })}
            aria-label={t('automation.tree.filter', { path })}
            className="grid size-7 place-items-center rounded text-ink-faint hover:bg-surface hover:text-accent"
          >
            <Filter size={12} />
          </button>
          <button
            type="button"
            onClick={() => onInsert(path)}
            title={t('automation.tree.insert', { path })}
            aria-label={t('automation.tree.insert', { path })}
            className="grid size-7 place-items-center rounded text-ink-faint hover:bg-surface hover:text-accent"
          >
            <Braces size={12} />
          </button>
        </span>
      </div>
      {branch && open ? (
        <ul role="group">
          {children.map(([key, child]) => (
            <Node key={key} name={key} value={child} path={`${path}.${key}`} depth={depth + 1} onFilter={onFilter} onInsert={onInsert} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
