import { parseSessionQuery, type ProjectDto } from '@sillage/protocol'
import { CircleHelp, Search, X } from 'lucide-react'
import { forwardRef, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx, IconButton } from '../ui'
import { PROBLEM_LABELS, suggest, type Suggestion } from './query-vocabulary'

/**
 * Query input with token colouring behind a transparent field, so the caret, selection and
 * native editing stay the browser's. Invalid tokens are underlined with their reason.
 */
export const QueryField = forwardRef<HTMLInputElement, {
  value: string
  onChange: (value: string) => void
  projects: readonly ProjectDto[]
  onHelp: () => void
}>(function QueryField({ value, onChange, projects, onHelp }, ref) {
  const t = useTranslate()
  const input = useRef<HTMLInputElement | null>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [active, setActive] = useState(0)

  const highlighted = useMemo(() => {
    const parts: ReactNode[] = []
    let position = 0
    for (const token of parseSessionQuery(value)) {
      if (token.start > position) parts.push(value.slice(position, token.start))
      const body = token.raw.slice(token.negated ? 1 : 0)
      const key = token.key ?? token.typedKey
      parts.push(token.problem ? (
        <span key={token.start} className="wall-query-invalid">{token.raw}</span>
      ) : (
        <span key={token.start}>
          {token.negated ? <span className="wall-query-negation">-</span> : null}
          {key ? <><span className="wall-query-key">{key}:</span>{body.slice(key.length + 1)}</> : <span className="wall-query-text">{body}</span>}
        </span>
      ))
      position = token.end
    }
    parts.push(value.slice(position))
    return parts
  }, [value])
  const problems = useMemo(() => parseSessionQuery(value).filter((token) => token.problem), [value])

  // Suggestions follow typing only: opening on focus would cover the filter buttons below.
  const refresh = (node: HTMLInputElement) => {
    const next = suggest(node.value, node.selectionStart ?? node.value.length, projects, t).slice(0, 8)
    setSuggestions(next)
    setActive(0)
  }
  const apply = (suggestion: Suggestion) => {
    const node = input.current
    if (!node) return
    const caret = node.selectionStart ?? node.value.length
    const before = node.value.slice(0, caret).replace(/\S*$/, suggestion.insert)
    const after = node.value.slice(caret).replace(/^\S*/, '')
    onChange(before + after)
    requestAnimationFrame(() => {
      node.setSelectionRange(before.length, before.length)
      refresh(node)
    })
  }

  return (
    <div className="wall-query">
      <Search size={15} className="shrink-0 text-ink-faint" aria-hidden />
      <div className="wall-query-stack">
        <div ref={overlay} className="wall-query-overlay" aria-hidden>{highlighted}</div>
        <input
          ref={(node) => {
            input.current = node
            if (typeof ref === 'function') ref(node)
            else if (ref) ref.current = node
          }}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('wall.query.label')}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls="wall-query-suggestions"
          aria-invalid={problems.length > 0 || undefined}
          placeholder={t('wall.query.placeholder')}
          onChange={(event) => { onChange(event.target.value); refresh(event.target) }}
          onScroll={(event) => { if (overlay.current) overlay.current.scrollLeft = event.currentTarget.scrollLeft }}
          onBlur={() => window.setTimeout(() => setSuggestions([]), 120)}
          onKeyDown={(event) => {
            if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
            } else if (suggestions.length && (event.key === 'Enter' || event.key === 'Tab') && suggestions[active]) {
              event.preventDefault()
              apply(suggestions[active])
            } else if (event.key === 'Escape') {
              if (suggestions.length) setSuggestions([])
              else event.currentTarget.blur()
            }
            requestAnimationFrame(() => { if (overlay.current && input.current) overlay.current.scrollLeft = input.current.scrollLeft })
          }}
          className="wall-query-input"
        />
      </div>
      {problems.length ? (
        <span className="wall-query-problem" role="status">{t(PROBLEM_LABELS[problems[0]!.problem!], { token: problems[0]!.raw })}</span>
      ) : null}
      {value ? <IconButton size="sm" label={t('wall.query.clear')} onClick={() => { onChange(''); input.current?.focus() }}><X size={14} /></IconButton> : null}
      <kbd className="wall-query-kbd" aria-hidden>/</kbd>
      <IconButton size="sm" label={t('wall.query.help')} onClick={onHelp}><CircleHelp size={15} /></IconButton>
      {suggestions.length ? (
        <ul id="wall-query-suggestions" role="listbox" className="wall-query-suggestions">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.label} role="option" aria-selected={index === active}
              className={cx(index === active && 'wall-query-suggestion-active')}
              onMouseDown={(event) => { event.preventDefault(); apply(suggestion) }}>
              <span className="font-mono"><b>{suggestion.label.slice(0, suggestion.matched)}</b>{suggestion.label.slice(suggestion.matched)}</span>
              <span className="wall-query-suggestion-hint">{suggestion.hint}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
})
