import * as Dialog from '@radix-ui/react-dialog'
import { Loader, MessageSquare, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SEARCH_MIN_QUERY, type ConversationDto, type SearchMessageDto } from '@sillage/protocol'
import { useAllConversations } from '../lib/conversations'
import { useProjects } from '../lib/projects'
import { scoreMatch, splitExcerpt, useMessageSearch } from '../lib/search'
import { AgentIcon } from './AgentIcon'
import { cx } from './ui'

/** Conversations proposées : au-delà, la section contenu passe sous la ligne de flottaison. */
const TITLE_LIMIT = 6

interface Entry {
  key: string
  to: string
  conversation: ConversationDto
  /** Absent pour un résultat de titre : il n'y a alors pas de passage à montrer. */
  message?: SearchMessageDto
}

function toEntry(conversation: ConversationDto, message?: SearchMessageDto): Entry {
  const base = `/p/${conversation.projectId}/c/${conversation.id}`
  return {
    key: message ? `m-${conversation.id}-${message.seq}` : `c-${conversation.id}`,
    // Le `seq` ouvre le fil sur le message trouvé plutôt qu'en haut.
    to: message ? `${base}?seq=${message.seq}` : base,
    conversation,
    message,
  }
}

/**
 * Palette de recherche.
 *
 * Deux sections plutôt qu'une bascule à mémoriser : les titres répondent à la frappe
 * sans réseau, la liste des conversations étant déjà chargée pour la navigation, et le
 * contenu arrive derrière, une fois la saisie stabilisée.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const { data: conversations } = useAllConversations()
  const { data: projects } = useProjects()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const { data: messages, isFetching } = useMessageSearch(open ? query : '')

  // Rouvrir la palette doit repartir d'une page blanche : la recherche précédente
  // répondait à une intention qui n'est plus celle du moment.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  const projectNames = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects],
  )

  const titleMatches = useMemo((): ConversationDto[] => {
    const all = conversations ?? []
    const trimmed = query.trim()

    // Sans saisie, les conversations les plus récentes : la palette sert alors de
    // sélecteur rapide, ce qui est son autre usage.
    if (!trimmed) {
      return [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, TITLE_LIMIT)
    }

    return all
      .map((conversation) => {
        const name = projectNames.get(conversation.projectId) ?? ''
        const score = scoreMatch(`${conversation.title} ${name}`, trimmed)
        return score === null ? null : { conversation, score }
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, TITLE_LIMIT)
      .map((entry) => entry.conversation)
  }, [conversations, projectNames, query])

  const messageMatches = useMemo((): Entry[] => {
    const byId = new Map((conversations ?? []).map((entry) => [entry.id, entry]))
    return (messages ?? [])
      .map((message) => {
        const conversation = byId.get(message.conversationId)
        return conversation ? toEntry(conversation, message) : null
      })
      .filter((entry) => entry !== null)
  }, [conversations, messages])

  const titleEntries = useMemo(
    () => titleMatches.map((conversation) => toEntry(conversation)),
    [titleMatches],
  )
  const entries = useMemo(
    () => [...titleEntries, ...messageMatches],
    [titleEntries, messageMatches],
  )

  // La liste change à chaque frappe : garder l'ancien indice ferait pointer la
  // sélection sur un résultat qui n'est plus celui qu'on regardait.
  useEffect(() => setActive(0), [query, entries.length])

  const searching = query.trim().length >= SEARCH_MIN_QUERY

  const go = (entry: Entry | undefined) => {
    if (!entry) return
    onOpenChange(false)
    navigate(entry.to)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (entries.length ? (index + 1) % entries.length : 0))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (entries.length ? (index - 1 + entries.length) % entries.length : 0))
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      go(entries[active])
    }
  }

  // La sélection au clavier doit rester visible quand elle sort de la zone affichée.
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-label="Recherche"
          className={cx(
            'surface fixed z-50 flex flex-col overflow-hidden border-line shadow-pop',
            'inset-0 border-0',
            'sm:inset-auto sm:top-24 sm:left-1/2 sm:max-h-[70dvh] sm:w-[min(38rem,92vw)]',
            'sm:-translate-x-1/2 sm:rounded-xl sm:border',
          )}
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">Rechercher</Dialog.Title>

          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 pt-safe">
            <Search size={16} className="shrink-0 text-ink-faint" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Rechercher une conversation ou un message..."
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            {searching && isFetching ? (
              <Loader size={15} className="shrink-0 animate-spin text-ink-faint" />
            ) : null}
          </div>

          <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5 pb-safe">
            <Section label={query.trim() ? 'Conversations' : 'Récentes'} count={titleEntries.length}>
              {titleEntries.map((entry, index) => (
                <Row
                  key={entry.key}
                  entry={entry}
                  project={projectNames.get(entry.conversation.projectId)}
                  activeRow={active === index}
                  onHover={() => setActive(index)}
                  onSelect={() => go(entry)}
                />
              ))}
            </Section>

            {searching ? (
              <Section label="Messages" count={messageMatches.length}>
                {messageMatches.map((entry, index) => (
                  <Row
                    key={entry.key}
                    entry={entry}
                    project={projectNames.get(entry.conversation.projectId)}
                    activeRow={active === titleEntries.length + index}
                    onHover={() => setActive(titleEntries.length + index)}
                    onSelect={() => go(entry)}
                  />
                ))}
              </Section>
            ) : null}

            {entries.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-sm text-ink-faint">
                {query.trim().length > 0 && !searching
                  ? `Encore ${SEARCH_MIN_QUERY - query.trim().length} caractère(s) pour chercher dans les messages.`
                  : 'Aucun résultat.'}
              </p>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Section({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div className="mb-1">
      <p className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
        {label}
      </p>
      {children}
    </div>
  )
}

function Row({
  entry,
  project,
  activeRow,
  onHover,
  onSelect,
}: {
  entry: Entry
  project: string | undefined
  activeRow: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const { conversation, message } = entry

  return (
    <button
      type="button"
      data-active={activeRow}
      onMouseMove={onHover}
      onClick={onSelect}
      className={cx(
        'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left',
        activeRow ? 'bg-accent-wash text-ink' : 'text-ink-soft',
      )}
    >
      <span className="mt-0.5 shrink-0 text-ink-faint">
        {message ? <MessageSquare size={14} /> : <AgentIcon agent={conversation.agent} size={14} />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm">{conversation.title}</span>
          {project ? (
            <span className="shrink-0 text-[0.6875rem] text-ink-faint">{project}</span>
          ) : null}
        </span>

        {message ? (
          <span className="mt-0.5 block text-xs text-ink-faint">
            <span className="mr-1.5 text-[0.6875rem]">
              {message.role === 'user' ? 'Toi' : 'Agent'}
            </span>
            {splitExcerpt(message.excerpt).map((part, index) =>
              part.hit ? (
                // Fond franc plutôt que le lavis d'accent : la ligne sélectionnée porte
                // déjà ce lavis, et le passage trouvé s'y confondait.
                <mark key={index} className="rounded bg-accent/25 px-0.5 font-medium text-ink">
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </span>
        ) : null}
      </span>
    </button>
  )
}
